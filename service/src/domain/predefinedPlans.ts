export type PlanScope = 'account' | 'user';

export interface PredefinedPlan {
  id: string;
  scope: PlanScope;
  name: string;
  monthlyAllowance: number;
  maxUnitsPerRequest: number;
}

// Fixed ids so clients (and the demo) can reference them across restarts.
export const PLAN_IDS = {
  starter: '00000000-0000-4000-8000-00000000a001',
  pro: '00000000-0000-4000-8000-00000000a002',
  basic: '00000000-0000-4000-8000-00000000b001',
  premium: '00000000-0000-4000-8000-00000000b002',
} as const;

// Starter/Basic match the example in the brief (10,000/100 and 1,000/20).
export const PREDEFINED_PLANS: readonly PredefinedPlan[] = [
  { id: PLAN_IDS.starter, scope: 'account', name: 'Starter', monthlyAllowance: 10_000, maxUnitsPerRequest: 100 },
  { id: PLAN_IDS.pro, scope: 'account', name: 'Pro', monthlyAllowance: 100_000, maxUnitsPerRequest: 1_000 },
  { id: PLAN_IDS.basic, scope: 'user', name: 'Basic', monthlyAllowance: 1_000, maxUnitsPerRequest: 20 },
  { id: PLAN_IDS.premium, scope: 'user', name: 'Premium', monthlyAllowance: 10_000, maxUnitsPerRequest: 200 },
];

export const DEFAULT_ACCOUNT_PLAN_ID = PLAN_IDS.starter;
export const DEFAULT_USER_PLAN_ID = PLAN_IDS.basic;
