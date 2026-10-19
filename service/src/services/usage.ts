import type { Queryable } from '../db/pool.js';
import { periodLabel } from '../domain/period.js';
import { remainingUnits } from '../domain/rules.js';
import { toPlanDto, type PlanDto, type PlanRow } from './plans.js';

export interface LevelUsageDto {
  used: number;
  remaining: number | null;
  currentPlan: PlanDto;
}

export async function accountUsed(db: Queryable, accountId: string, period: string): Promise<number> {
  const result = await db.query<{ used: number }>('SELECT used FROM account_usage WHERE account_id = $1 AND period = $2', [
    accountId,
    period,
  ]);
  return result.rows[0]?.used ?? 0;
}

export async function userUsed(db: Queryable, userId: string, period: string): Promise<number> {
  const result = await db.query<{ used: number }>('SELECT used FROM user_usage WHERE user_id = $1 AND period = $2', [userId, period]);
  return result.rows[0]?.used ?? 0;
}

// "remaining" only makes sense for the current month - plans may have changed since a past one.
export function levelUsage(plan: PlanRow, used: number, isCurrentPeriod: boolean): LevelUsageDto {
  return {
    used,
    remaining: isCurrentPeriod ? remainingUnits({ monthlyAllowance: plan.monthly_allowance, maxUnitsPerRequest: plan.max_units_per_request }, used) : null,
    currentPlan: toPlanDto(plan),
  };
}

interface UserUsageRow extends PlanRow {
  external_id: string;
  used: number;
}

export async function usersUsage(
  db: Queryable,
  accountId: string,
  period: string,
  isCurrentPeriod: boolean,
  limit: number,
  cursor: string | undefined,
): Promise<{ items: Array<{ userId: string } & LevelUsageDto>; nextCursor: string | null }> {
  // LEFT JOIN so users with no usage this month still show up with 0. Keyset pagination on external_id.
  const result = await db.query<UserUsageRow>(
    `SELECT u.external_id, COALESCE(uu.used, 0) AS used,
            p.id, p.owner_account_id, p.scope, p.name, p.monthly_allowance, p.max_units_per_request, p.created_at, p.updated_at
       FROM users u
       JOIN plans p ON p.id = u.plan_id
       LEFT JOIN user_usage uu ON uu.user_id = u.id AND uu.period = $2
      WHERE u.account_id = $1 AND ($3::text IS NULL OR u.external_id > $3)
      ORDER BY u.external_id
      LIMIT $4`,
    [accountId, period, cursor ?? null, limit + 1],
  );
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  return {
    items: rows.map((row) => ({ userId: row.external_id, ...levelUsage(row, row.used, isCurrentPeriod) })),
    nextCursor: hasMore ? (rows[rows.length - 1]?.external_id ?? null) : null,
  };
}

export async function accountMonths(db: Queryable, accountId: string, limit: number): Promise<Array<{ period: string; used: number }>> {
  const result = await db.query<{ period: string; used: number }>(
    `SELECT to_char(period, 'YYYY-MM-DD') AS period, used FROM account_usage
      WHERE account_id = $1 ORDER BY period DESC LIMIT $2`,
    [accountId, limit],
  );
  return result.rows.map((row) => ({ period: periodLabel(row.period), used: row.used }));
}

export async function userMonths(db: Queryable, userId: string, limit: number): Promise<Array<{ period: string; used: number }>> {
  const result = await db.query<{ period: string; used: number }>(
    `SELECT to_char(period, 'YYYY-MM-DD') AS period, used FROM user_usage
      WHERE user_id = $1 ORDER BY period DESC LIMIT $2`,
    [userId, limit],
  );
  return result.rows.map((row) => ({ period: periodLabel(row.period), used: row.used }));
}
