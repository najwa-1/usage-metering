import { withTransaction, type PoolClient, type Queryable } from '../db/pool.js';
import { periodStart } from '../domain/period.js';
import { evaluate, type LevelState, type Violation } from '../domain/rules.js';
import type { Deps } from '../deps.js';
import { conflict, isUniqueViolation, notFound } from '../http/errors.js';
import { STORED_DECISION_SELECT, toDecisionDto, type DecisionDto, type StoredDecisionRow } from './decisions.js';

export interface ConsumeInput {
  userId: string;
  units: number;
  requestId: string;
}

interface ConsumeContext {
  user_id: string;
  external_id: string;
  user_plan_id: string;
  user_plan_name: string;
  user_monthly: number;
  user_max: number;
  account_plan_id: string;
  account_plan_name: string;
  account_monthly: number;
  account_max: number;
  already_decided: boolean;
}

async function findStoredDecision(db: Queryable, accountId: string, requestId: string): Promise<StoredDecisionRow | null> {
  const result = await db.query<StoredDecisionRow>(`${STORED_DECISION_SELECT} WHERE r.account_id = $1 AND r.request_id = $2`, [
    accountId,
    requestId,
  ]);
  return result.rows[0] ?? null;
}

// A requestId is one decision forever. Same body -> same answer (nothing counted again).
// Same id with a different user/amount is a client bug, so we refuse instead of guessing.
function replay(stored: StoredDecisionRow, input: ConsumeInput): DecisionDto {
  if (stored.external_id !== input.userId || stored.units !== input.units) {
    throw conflict('REQUEST_ID_REUSED', 'This requestId was already used for a different request', {
      originalUserId: stored.external_id,
      originalUnits: stored.units,
    });
  }
  return toDecisionDto(stored, true);
}

async function replayStored(db: Queryable, accountId: string, input: ConsumeInput): Promise<DecisionDto | null> {
  const stored = await findStoredDecision(db, accountId, input.requestId);
  return stored ? replay(stored, input) : null;
}

// User + both plans in one round trip, plus a cheap "already decided?" check.
// Filtering by account_id is what keeps one account from touching another's users.
async function loadContext(db: Queryable, accountId: string, input: ConsumeInput): Promise<ConsumeContext | null> {
  const result = await db.query<ConsumeContext>(
    `SELECT u.id AS user_id, u.external_id,
            up.id AS user_plan_id, up.name AS user_plan_name,
            up.monthly_allowance AS user_monthly, up.max_units_per_request AS user_max,
            ap.id AS account_plan_id, ap.name AS account_plan_name,
            ap.monthly_allowance AS account_monthly, ap.max_units_per_request AS account_max,
            EXISTS (SELECT 1 FROM usage_requests r WHERE r.account_id = $1 AND r.request_id = $3) AS already_decided
       FROM users u
       JOIN accounts a ON a.id = u.account_id
       JOIN plans up ON up.id = u.plan_id
       JOIN plans ap ON ap.id = a.plan_id
      WHERE u.account_id = $1 AND u.external_id = $2`,
    [accountId, input.userId, input.requestId],
  );
  return result.rows[0] ?? null;
}

// user first so user-level reasons are reported before account-level ones
function levels(ctx: ConsumeContext, userUsed: number, accountUsed: number): LevelState[] {
  return [
    { scope: 'user', limits: { monthlyAllowance: ctx.user_monthly, maxUnitsPerRequest: ctx.user_max }, used: userUsed },
    { scope: 'account', limits: { monthlyAllowance: ctx.account_monthly, maxUnitsPerRequest: ctx.account_max }, used: accountUsed },
  ];
}

interface DecisionValues {
  accountId: string;
  ctx: ConsumeContext;
  input: ConsumeInput;
  period: string;
  violations: Violation[];
  accountUsedAfter: number;
  userUsedAfter: number;
  now: Date;
}

interface InsertMode {
  applyToCounters: boolean;
  skipOnConflict: boolean;
}

async function insertDecision(db: Queryable, values: DecisionValues, mode: InsertMode): Promise<StoredDecisionRow | null> {
  const { accountId, ctx, input, period, violations, accountUsedAfter, userUsedAfter, now } = values;
  const accepted = violations.length === 0;
  const reason = violations[0];
  // Counters and the history row are written in a single statement (data-modifying CTEs).
  // The UPDATEs are no-ops when the decision is a rejection.
  const applyPrefix = mode.applyToCounters
    ? `WITH account_update AS (
         UPDATE account_usage SET used = used + $4, updated_at = now()
          WHERE $5::boolean AND account_id = $1 AND period = $6
       ), user_update AS (
         UPDATE user_usage SET used = used + $4, updated_at = now()
          WHERE $5::boolean AND user_id = $2 AND period = $6
       )`
    : '';
  const result = await db.query<Omit<StoredDecisionRow, 'external_id' | 'account_plan_name' | 'user_plan_name'>>(
    `${applyPrefix}
     INSERT INTO usage_requests
       (account_id, user_id, request_id, units, accepted, period, rejection_scope, rejection_rule, violations,
        account_plan_id, account_monthly_limit, account_request_limit, account_used_after,
        user_plan_id, user_monthly_limit, user_request_limit, user_used_after, decided_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     ${mode.skipOnConflict ? 'ON CONFLICT (account_id, request_id) DO NOTHING' : ''}
     RETURNING id, request_id, units, accepted, period, rejection_scope, rejection_rule, violations,
               account_plan_id, account_monthly_limit, account_request_limit, account_used_after,
               user_plan_id, user_monthly_limit, user_request_limit, user_used_after, decided_at`,
    [
      accountId,
      ctx.user_id,
      input.requestId,
      input.units,
      accepted,
      period,
      reason?.scope ?? null,
      reason?.rule ?? null,
      JSON.stringify(violations),
      ctx.account_plan_id,
      ctx.account_monthly,
      ctx.account_max,
      accountUsedAfter,
      ctx.user_plan_id,
      ctx.user_monthly,
      ctx.user_max,
      userUsedAfter,
      now,
    ],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...row, external_id: ctx.external_id, account_plan_name: ctx.account_plan_name, user_plan_name: ctx.user_plan_name };
}

// INSERT ... ON CONFLICT DO UPDATE creates the month's row if needed AND takes its row lock,
// so we never race on "row doesn't exist yet". The no-op SET is only there to get the lock.
async function lockUserCounter(client: PoolClient, accountId: string, userId: string, period: string): Promise<number> {
  const result = await client.query<{ used: number }>(
    `INSERT INTO user_usage (user_id, account_id, period, used) VALUES ($1, $2, $3, 0)
     ON CONFLICT (user_id, period) DO UPDATE SET used = user_usage.used
     RETURNING used`,
    [userId, accountId, period],
  );
  return result.rows[0]?.used ?? 0;
}

async function lockAccountCounter(client: PoolClient, accountId: string, period: string): Promise<number> {
  const result = await client.query<{ used: number }>(
    `INSERT INTO account_usage (account_id, period, used) VALUES ($1, $2, 0)
     ON CONFLICT (account_id, period) DO UPDATE SET used = account_usage.used
     RETURNING used`,
    [accountId, period],
  );
  return result.rows[0]?.used ?? 0;
}

export async function consume(deps: Deps, accountId: string, input: ConsumeInput): Promise<DecisionDto> {
  // read the clock once so the whole decision lands in a single UTC month
  const now = deps.clock();
  const period = periodStart(now);

  const ctx = await loadContext(deps.pool, accountId, input);
  if (!ctx) {
    const replayed = await replayStored(deps.pool, accountId, input);
    if (replayed) return replayed;
    throw notFound('USER_NOT_FOUND', `User "${input.userId}" is not registered under this account`);
  }

  if (ctx.already_decided) {
    const replayed = await replayStored(deps.pool, accountId, input);
    if (replayed) return replayed;
  }

  // Per-request limits don't depend on usage, so these rejections are certain and
  // can be recorded without taking any lock.
  const staticViolations = evaluate(input.units, levels(ctx, 0, 0), { includeUsageRules: false });
  if (staticViolations.length > 0) {
    const usage = await deps.pool.query<{ account_used: number; user_used: number }>(
      `SELECT COALESCE((SELECT used FROM account_usage WHERE account_id = $1 AND period = $3), 0) AS account_used,
              COALESCE((SELECT used FROM user_usage WHERE user_id = $2 AND period = $3), 0) AS user_used`,
      [accountId, ctx.user_id, period],
    );
    const current = usage.rows[0] ?? { account_used: 0, user_used: 0 };
    const stored = await insertDecision(
      deps.pool,
      { accountId, ctx, input, period, violations: staticViolations, accountUsedAfter: current.account_used, userUsedAfter: current.user_used, now },
      { applyToCounters: false, skipOnConflict: true },
    );
    if (stored) return toDecisionDto(stored, false);
    // lost a race with a retry of the same request
    const replayed = await replayStored(deps.pool, accountId, input);
    if (replayed) return replayed;
  }

  try {
    return await withTransaction(deps.pool, async (client) => {
      // Lock order is always user -> account (no deadlocks). The account row is the
      // contended one, so taking it last keeps it locked for as short as possible.
      // Anyone else spending from this account waits here and then sees our new total.
      const userUsed = await lockUserCounter(client, accountId, ctx.user_id, period);
      const accountUsed = await lockAccountCounter(client, accountId, period);

      const violations = evaluate(input.units, levels(ctx, userUsed, accountUsed), { includeUsageRules: true });
      const accepted = violations.length === 0;

      const stored = await insertDecision(
        client,
        {
          accountId,
          ctx,
          input,
          period,
          violations,
          accountUsedAfter: accepted ? accountUsed + input.units : accountUsed,
          userUsedAfter: accepted ? userUsed + input.units : userUsed,
          now,
        },
        { applyToCounters: true, skipOnConflict: false },
      );
      return toDecisionDto(stored as StoredDecisionRow, false);
    });
  } catch (error) {
    // A concurrent copy of this requestId committed first. Our transaction rolled back,
    // so nothing was double counted - just return the winner's decision.
    if (isUniqueViolation(error)) {
      const replayed = await replayStored(deps.pool, accountId, input);
      if (replayed) return replayed;
    }
    throw error;
  }
}
