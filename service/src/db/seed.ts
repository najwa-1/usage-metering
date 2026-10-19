import { PREDEFINED_PLANS } from '../domain/predefinedPlans.js';
import type { Pool } from './pool.js';

// Runs on every startup. predefinedPlans.ts is the source of truth for these rows.
export async function seedPredefinedPlans(pool: Pool): Promise<void> {
  for (const plan of PREDEFINED_PLANS) {
    await pool.query(
      `INSERT INTO plans (id, owner_account_id, scope, name, monthly_allowance, max_units_per_request)
       VALUES ($1, NULL, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name,
             monthly_allowance = EXCLUDED.monthly_allowance,
             max_units_per_request = EXCLUDED.max_units_per_request,
             updated_at = now()
         WHERE (plans.name, plans.monthly_allowance, plans.max_units_per_request)
               IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.monthly_allowance, EXCLUDED.max_units_per_request)`,
      [plan.id, plan.scope, plan.name, plan.monthlyAllowance, plan.maxUnitsPerRequest],
    );
  }
}
