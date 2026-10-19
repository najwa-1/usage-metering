import { withTransaction, type Pool, type Queryable } from '../db/pool.js';
import { DEFAULT_USER_PLAN_ID } from '../domain/predefinedPlans.js';
import { periodLabel, periodStart } from '../domain/period.js';
import { conflict, isUniqueViolation, notFound } from '../http/errors.js';
import { getAssignablePlan, toPlanDto, type PlanDto, type PlanRow } from './plans.js';
import { accountUsed, levelUsage, userUsed, type LevelUsageDto } from './usage.js';

export interface UserDto {
  userId: string;
  plan: PlanDto;
  createdAt: string;
}

export interface UserPlanRow extends PlanRow {
  user_id: string;
  external_id: string;
  user_created_at: Date;
}

const USER_WITH_PLAN = `
  SELECT u.id AS user_id, u.external_id, u.created_at AS user_created_at,
         p.id, p.owner_account_id, p.scope, p.name, p.monthly_allowance, p.max_units_per_request, p.created_at, p.updated_at
    FROM users u JOIN plans p ON p.id = u.plan_id`;

function toUserDto(row: UserPlanRow): UserDto {
  return { userId: row.external_id, plan: toPlanDto(row), createdAt: row.user_created_at.toISOString() };
}

export async function findUser(db: Queryable, accountId: string, externalId: string): Promise<UserPlanRow> {
  const result = await db.query<UserPlanRow>(`${USER_WITH_PLAN} WHERE u.account_id = $1 AND u.external_id = $2`, [accountId, externalId]);
  const row = result.rows[0];
  if (!row) throw notFound('USER_NOT_FOUND', `User "${externalId}" is not registered under this account`);
  return row;
}

export async function createUser(pool: Pool, accountId: string, input: { userId: string; planId?: string | undefined }): Promise<UserDto> {
  const planId = input.planId ?? DEFAULT_USER_PLAN_ID;
  try {
    await withTransaction(pool, async (client) => {
      const plan = await getAssignablePlan(client, accountId, planId, 'user');
      const inserted = await client.query<{ id: string }>(
        'INSERT INTO users (account_id, external_id, plan_id) VALUES ($1, $2, $3) RETURNING id',
        [accountId, input.userId, plan.id],
      );
      await client.query('INSERT INTO plan_assignments (account_id, user_id, plan_id) VALUES ($1, $2, $3)', [
        accountId,
        inserted.rows[0]?.id,
        plan.id,
      ]);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict('USER_ALREADY_EXISTS', `User "${input.userId}" is already registered`);
    throw error;
  }
  return toUserDto(await findUser(pool, accountId, input.userId));
}

export async function listUsers(db: Queryable, accountId: string, limit: number, cursor?: string): Promise<{ items: UserDto[]; nextCursor: string | null }> {
  const result = await db.query<UserPlanRow>(
    `${USER_WITH_PLAN} WHERE u.account_id = $1 AND ($2::text IS NULL OR u.external_id > $2) ORDER BY u.external_id LIMIT $3`,
    [accountId, cursor ?? null, limit + 1],
  );
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  return { items: rows.map(toUserDto), nextCursor: hasMore ? (rows[rows.length - 1]?.external_id ?? null) : null };
}

export async function getUserOverview(db: Queryable, accountId: string, externalId: string, now: Date) {
  const row = await findUser(db, accountId, externalId);
  const period = periodStart(now);
  const used = await userUsed(db, row.user_id, period);
  return { ...toUserDto(row), usage: { period: periodLabel(period), ...levelUsage(row, used, true) } };
}

export async function getUserUsage(
  db: Queryable,
  accountId: string,
  externalId: string,
  period: string,
  now: Date,
  accountPlan: PlanRow,
): Promise<{ period: string; isCurrentPeriod: boolean; user: { userId: string } & LevelUsageDto; account: LevelUsageDto }> {
  const row = await findUser(db, accountId, externalId);
  const isCurrentPeriod = period === periodStart(now);
  const [uUsed, aUsed] = await Promise.all([userUsed(db, row.user_id, period), accountUsed(db, accountId, period)]);
  return {
    period: periodLabel(period),
    isCurrentPeriod,
    user: { userId: row.external_id, ...levelUsage(row, uUsed, isCurrentPeriod) },
    account: levelUsage(accountPlan, aUsed, isCurrentPeriod),
  };
}

export async function assignUserPlan(pool: Pool, accountId: string, externalId: string, planId: string, now: Date) {
  await withTransaction(pool, async (client) => {
    const user = await findUser(client, accountId, externalId);
    const plan = await getAssignablePlan(client, accountId, planId, 'user');
    await client.query('UPDATE users SET plan_id = $2 WHERE id = $1', [user.user_id, plan.id]);
    await client.query('INSERT INTO plan_assignments (account_id, user_id, plan_id) VALUES ($1, $2, $3)', [accountId, user.user_id, plan.id]);
  });
  return getUserOverview(pool, accountId, externalId, now);
}
