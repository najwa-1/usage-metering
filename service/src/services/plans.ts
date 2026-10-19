import type { Queryable } from '../db/pool.js';
import type { PlanScope } from '../domain/predefinedPlans.js';
import { badRequest, conflict, forbidden, isUniqueViolation, notFound } from '../http/errors.js';

export interface PlanRow {
  id: string;
  owner_account_id: string | null;
  scope: PlanScope;
  name: string;
  monthly_allowance: number;
  max_units_per_request: number;
  created_at: Date;
  updated_at: Date;
}

export interface PlanDto {
  id: string;
  name: string;
  scope: PlanScope;
  type: 'predefined' | 'custom';
  monthlyAllowance: number;
  maxUnitsPerRequest: number;
  createdAt: string;
  updatedAt: string;
}

const PLAN_COLUMNS = 'id, owner_account_id, scope, name, monthly_allowance, max_units_per_request, created_at, updated_at';

export function toPlanDto(row: PlanRow): PlanDto {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    type: row.owner_account_id === null ? 'predefined' : 'custom',
    monthlyAllowance: row.monthly_allowance,
    maxUnitsPerRequest: row.max_units_per_request,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listPlans(db: Queryable, accountId: string, scope?: PlanScope): Promise<PlanDto[]> {
  const result = await db.query<PlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM plans
      WHERE (owner_account_id IS NULL OR owner_account_id = $1)
        AND ($2::text IS NULL OR scope = $2)
      ORDER BY owner_account_id NULLS FIRST, scope, monthly_allowance, name`,
    [accountId, scope ?? null],
  );
  return result.rows.map(toPlanDto);
}

// Predefined plans + this account's own. Someone else's plan is a 404, not a 403,
// so we don't reveal that it exists.
export async function getVisiblePlan(db: Queryable, accountId: string, planId: string): Promise<PlanRow> {
  const result = await db.query<PlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM plans WHERE id = $1 AND (owner_account_id IS NULL OR owner_account_id = $2)`,
    [planId, accountId],
  );
  const plan = result.rows[0];
  if (!plan) throw notFound('PLAN_NOT_FOUND', `Plan ${planId} was not found`);
  return plan;
}

export async function getAssignablePlan(db: Queryable, accountId: string, planId: string, scope: PlanScope): Promise<PlanRow> {
  const plan = await getVisiblePlan(db, accountId, planId);
  if (plan.scope !== scope) {
    throw badRequest('PLAN_SCOPE_MISMATCH', `Plan "${plan.name}" is a ${plan.scope} plan and cannot be assigned to a ${scope}`);
  }
  return plan;
}

export interface CreatePlanInput {
  name: string;
  scope: PlanScope;
  monthlyAllowance: number;
  maxUnitsPerRequest: number;
}

export async function createPlan(db: Queryable, accountId: string, input: CreatePlanInput): Promise<PlanDto> {
  try {
    const result = await db.query<PlanRow>(
      `INSERT INTO plans (owner_account_id, scope, name, monthly_allowance, max_units_per_request)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${PLAN_COLUMNS}`,
      [accountId, input.scope, input.name, input.monthlyAllowance, input.maxUnitsPerRequest],
    );
    return toPlanDto(result.rows[0] as PlanRow);
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict('PLAN_NAME_TAKEN', `You already have a ${input.scope} plan named "${input.name}"`);
    throw error;
  }
}

export interface UpdatePlanInput {
  name?: string | undefined;
  monthlyAllowance?: number | undefined;
  maxUnitsPerRequest?: number | undefined;
}

export async function updatePlan(db: Queryable, accountId: string, planId: string, input: UpdatePlanInput): Promise<PlanDto> {
  const existing = await getVisiblePlan(db, accountId, planId);
  if (existing.owner_account_id === null) {
    throw forbidden('PREDEFINED_PLAN_READ_ONLY', 'Predefined plans cannot be modified; create a custom plan instead');
  }
  try {
    const result = await db.query<PlanRow>(
      // COALESCE keeps fields that weren't sent. No cache anywhere, so the next request sees this.
      `UPDATE plans
          SET name = COALESCE($3, name),
              monthly_allowance = COALESCE($4, monthly_allowance),
              max_units_per_request = COALESCE($5, max_units_per_request),
              updated_at = now()
        WHERE id = $1 AND owner_account_id = $2
        RETURNING ${PLAN_COLUMNS}`,
      [planId, accountId, input.name ?? null, input.monthlyAllowance ?? null, input.maxUnitsPerRequest ?? null],
    );
    return toPlanDto(result.rows[0] as PlanRow);
  } catch (error) {
    if (isUniqueViolation(error)) throw conflict('PLAN_NAME_TAKEN', `You already have a ${existing.scope} plan named "${input.name}"`);
    throw error;
  }
}
