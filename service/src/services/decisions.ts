import { periodLabel } from '../domain/period.js';
import { remainingUnits, type RuleCode, type Violation } from '../domain/rules.js';
import type { PlanScope } from '../domain/predefinedPlans.js';

export interface StoredDecisionRow {
  id: number;
  request_id: string;
  external_id: string;
  units: number;
  accepted: boolean;
  period: string;
  rejection_scope: PlanScope | null;
  rejection_rule: RuleCode | null;
  violations: Violation[];
  account_plan_id: string;
  account_plan_name: string;
  account_monthly_limit: number;
  account_request_limit: number;
  account_used_after: number;
  user_plan_id: string;
  user_plan_name: string;
  user_monthly_limit: number;
  user_request_limit: number;
  user_used_after: number;
  decided_at: Date;
}

export const STORED_DECISION_SELECT = `
  SELECT r.id, r.request_id, u.external_id, r.units, r.accepted, r.period,
         r.rejection_scope, r.rejection_rule, r.violations,
         r.account_plan_id, ap.name AS account_plan_name, r.account_monthly_limit, r.account_request_limit, r.account_used_after,
         r.user_plan_id, up.name AS user_plan_name, r.user_monthly_limit, r.user_request_limit, r.user_used_after,
         r.decided_at
    FROM usage_requests r
    JOIN users u ON u.id = r.user_id
    JOIN plans ap ON ap.id = r.account_plan_id
    JOIN plans up ON up.id = r.user_plan_id`;

export interface DecisionLevelDto {
  planId: string;
  planName: string;
  monthlyAllowance: number;
  maxUnitsPerRequest: number;
  used: number;
  remaining: number;
}

export interface DecisionDto {
  requestId: string;
  userId: string;
  units: number;
  accepted: boolean;
  replayed: boolean;
  period: string;
  rejection: Violation | null;
  violations: Violation[];
  account: DecisionLevelDto;
  user: DecisionLevelDto;
  decidedAt: string;
}

export function toDecisionDto(row: StoredDecisionRow, replayed: boolean): DecisionDto {
  // jsonb doesn't keep key order, rebuild so responses look the same every time
  const violations: Violation[] = row.violations.map((v) => ({
    scope: v.scope,
    rule: v.rule,
    limit: v.limit,
    requested: v.requested,
    remaining: v.remaining,
    message: v.message,
  }));
  return {
    requestId: row.request_id,
    userId: row.external_id,
    units: row.units,
    accepted: row.accepted,
    replayed,
    period: periodLabel(row.period),
    rejection: row.accepted ? null : (violations[0] ?? null),
    violations,
    account: {
      planId: row.account_plan_id,
      planName: row.account_plan_name,
      monthlyAllowance: row.account_monthly_limit,
      maxUnitsPerRequest: row.account_request_limit,
      used: row.account_used_after,
      remaining: remainingUnits({ monthlyAllowance: row.account_monthly_limit, maxUnitsPerRequest: row.account_request_limit }, row.account_used_after),
    },
    user: {
      planId: row.user_plan_id,
      planName: row.user_plan_name,
      monthlyAllowance: row.user_monthly_limit,
      maxUnitsPerRequest: row.user_request_limit,
      used: row.user_used_after,
      remaining: remainingUnits({ monthlyAllowance: row.user_monthly_limit, maxUnitsPerRequest: row.user_request_limit }, row.user_used_after),
    },
    decidedAt: row.decided_at.toISOString(),
  };
}
