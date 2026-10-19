import { withTransaction, type Pool, type Queryable } from '../db/pool.js';
import { apiKeyDisplayPrefix, generateApiKey, hashApiKey } from '../domain/apiKey.js';
import { DEFAULT_ACCOUNT_PLAN_ID } from '../domain/predefinedPlans.js';
import { periodLabel, periodStart } from '../domain/period.js';
import { badRequest, notFound } from '../http/errors.js';
import { getAssignablePlan, toPlanDto, type PlanDto, type PlanRow } from './plans.js';
import { accountUsed, levelUsage, type LevelUsageDto } from './usage.js';

export interface AccountDto {
  id: string;
  name: string;
  apiKeyPrefix: string;
  plan: PlanDto;
  createdAt: string;
}

export async function createAccount(pool: Pool, input: { name: string; planId?: string | undefined }): Promise<{ account: AccountDto; apiKey: string }> {
  const planId = input.planId ?? DEFAULT_ACCOUNT_PLAN_ID;
  const planResult = await pool.query<PlanRow>(
    `SELECT id, owner_account_id, scope, name, monthly_allowance, max_units_per_request, created_at, updated_at
       FROM plans WHERE id = $1 AND owner_account_id IS NULL`,
    [planId],
  );
  const plan = planResult.rows[0];
  if (!plan) throw notFound('PLAN_NOT_FOUND', `Predefined plan ${planId} was not found`);
  if (plan.scope !== 'account') throw badRequest('PLAN_SCOPE_MISMATCH', `Plan "${plan.name}" is a user plan`);
  const apiKey = generateApiKey();
  const row = await withTransaction(pool, async (client) => {
    const inserted = await client.query<{ id: string; name: string; api_key_prefix: string; created_at: Date }>(
      `INSERT INTO accounts (name, api_key_hash, api_key_prefix, plan_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, api_key_prefix, created_at`,
      [input.name, hashApiKey(apiKey), apiKeyDisplayPrefix(apiKey), plan.id],
    );
    const account = inserted.rows[0] as { id: string; name: string; api_key_prefix: string; created_at: Date };
    await client.query('INSERT INTO plan_assignments (account_id, user_id, plan_id) VALUES ($1, NULL, $2)', [account.id, plan.id]);
    return account;
  });
  return {
    account: { id: row.id, name: row.name, apiKeyPrefix: row.api_key_prefix, plan: toPlanDto(plan), createdAt: row.created_at.toISOString() },
    apiKey,
  };
}

interface AccountPlanRow extends PlanRow {
  account_id: string;
  account_name: string;
  api_key_prefix: string;
  account_created_at: Date;
}

async function loadAccount(db: Queryable, accountId: string): Promise<AccountPlanRow> {
  const result = await db.query<AccountPlanRow>(
    `SELECT a.id AS account_id, a.name AS account_name, a.api_key_prefix, a.created_at AS account_created_at,
            p.id, p.owner_account_id, p.scope, p.name, p.monthly_allowance, p.max_units_per_request, p.created_at, p.updated_at
       FROM accounts a JOIN plans p ON p.id = a.plan_id
      WHERE a.id = $1`,
    [accountId],
  );
  const row = result.rows[0];
  if (!row) throw notFound('ACCOUNT_NOT_FOUND', 'Account not found');
  return row;
}

export async function getAccountPlan(db: Queryable, accountId: string): Promise<PlanRow> {
  return loadAccount(db, accountId);
}

export async function getAccountOverview(db: Queryable, accountId: string, now: Date): Promise<AccountDto & { usage: { period: string } & LevelUsageDto }> {
  const row = await loadAccount(db, accountId);
  const period = periodStart(now);
  const used = await accountUsed(db, accountId, period);
  return {
    id: row.account_id,
    name: row.account_name,
    apiKeyPrefix: row.api_key_prefix,
    plan: toPlanDto(row),
    createdAt: row.account_created_at.toISOString(),
    usage: { period: periodLabel(period), ...levelUsage(row, used, true) },
  };
}

export async function assignAccountPlan(pool: Pool, accountId: string, planId: string, now: Date) {
  await withTransaction(pool, async (client) => {
    const plan = await getAssignablePlan(client, accountId, planId, 'account');
    await client.query('UPDATE accounts SET plan_id = $2 WHERE id = $1', [accountId, plan.id]);
    await client.query('INSERT INTO plan_assignments (account_id, user_id, plan_id) VALUES ($1, NULL, $2)', [accountId, plan.id]);
  });
  return getAccountOverview(pool, accountId, now);
}
