import type { PlanScope } from './predefinedPlans.js';

export type RuleCode = 'max_units_per_request' | 'monthly_allowance';

export interface PlanLimits {
  monthlyAllowance: number;
  maxUnitsPerRequest: number;
}

export interface LevelState {
  scope: PlanScope;
  limits: PlanLimits;
  used: number;
}

export interface Violation {
  scope: PlanScope;
  rule: RuleCode;
  limit: number;
  requested: number;
  remaining: number | null;
  message: string;
}

// To add a rule: implement this and append it to RULES. It then applies to both the
// account and the user plan. dependsOnUsage=false rules are checked before any lock is taken.
interface Rule {
  code: RuleCode;
  dependsOnUsage: boolean;
  check(level: LevelState, units: number): Violation | null;
}

// Never negative: if a plan is lowered below what's already used, remaining is just 0.
export function remainingUnits(limits: PlanLimits, used: number): number {
  return Math.max(0, limits.monthlyAllowance - used);
}

const maxUnitsPerRequest: Rule = {
  code: 'max_units_per_request',
  dependsOnUsage: false,
  check(level, units) {
    if (units <= level.limits.maxUnitsPerRequest) return null;
    return {
      scope: level.scope,
      rule: 'max_units_per_request',
      limit: level.limits.maxUnitsPerRequest,
      requested: units,
      remaining: null,
      message: `Requested ${units} units but the ${level.scope} plan allows at most ${level.limits.maxUnitsPerRequest} per request.`,
    };
  },
};

const monthlyAllowance: Rule = {
  code: 'monthly_allowance',
  dependsOnUsage: true,
  check(level, units) {
    const remaining = remainingUnits(level.limits, level.used);
    if (units <= remaining) return null;
    return {
      scope: level.scope,
      rule: 'monthly_allowance',
      limit: level.limits.monthlyAllowance,
      requested: units,
      remaining,
      message: `Requested ${units} units but only ${remaining} of the ${level.scope} monthly allowance (${level.limits.monthlyAllowance}) remain.`,
    };
  },
};

const RULES: readonly Rule[] = [maxUnitsPerRequest, monthlyAllowance];

export interface EvaluateOptions {
  includeUsageRules: boolean;
}

// Returns every violation (empty = accepted). Order: per-request rules before monthly ones,
// user before account. The first one is what we report as the rejection reason.
export function evaluate(units: number, levels: readonly LevelState[], options: EvaluateOptions): Violation[] {
  const violations: Violation[] = [];
  for (const rule of RULES) {
    if (rule.dependsOnUsage && !options.includeUsageRules) continue;
    for (const level of levels) {
      const violation = rule.check(level, units);
      if (violation) violations.push(violation);
    }
  }
  return violations;
}
