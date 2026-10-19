import { describe, expect, it } from 'vitest';
import { evaluate, remainingUnits, type LevelState } from '../src/domain/rules.js';
import { parseMonth, periodStart } from '../src/domain/period.js';

function briefLevels(userUsed = 0, accountUsed = 0): LevelState[] {
  return [
    { scope: 'user', limits: { monthlyAllowance: 1_000, maxUnitsPerRequest: 20 }, used: userUsed },
    { scope: 'account', limits: { monthlyAllowance: 10_000, maxUnitsPerRequest: 100 }, used: accountUsed },
  ];
}

describe('rule engine', () => {
  it('rejects 25 units by the user per-request limit', () => {
    const violations = evaluate(25, briefLevels(), { includeUsageRules: true });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ scope: 'user', rule: 'max_units_per_request', limit: 20, requested: 25 });
  });

  it('accepts 10 units when both levels have room', () => {
    expect(evaluate(10, briefLevels(), { includeUsageRules: true })).toEqual([]);
  });

  it('rejects by the account monthly allowance when only 5 units remain', () => {
    const violations = evaluate(10, briefLevels(0, 9_995), { includeUsageRules: true });
    expect(violations[0]).toMatchObject({ scope: 'account', rule: 'monthly_allowance', remaining: 5 });
  });

  it('skips usage rules when includeUsageRules is false', () => {
    expect(evaluate(10, briefLevels(0, 9_995), { includeUsageRules: false })).toEqual([]);
  });

  it('reports every violation in a stable order', () => {
    const violations = evaluate(150, briefLevels(990, 9_990), { includeUsageRules: true });
    expect(violations.map((v) => `${v.scope}:${v.rule}`)).toEqual([
      'user:max_units_per_request',
      'account:max_units_per_request',
      'user:monthly_allowance',
      'account:monthly_allowance',
    ]);
  });

  it('clamps remaining to zero', () => {
    expect(remainingUnits({ monthlyAllowance: 100, maxUnitsPerRequest: 10 }, 300)).toBe(0);
  });
});

describe('periods', () => {
  it('uses UTC calendar months', () => {
    expect(periodStart(new Date('2026-10-31T23:59:59Z'))).toBe('2026-10-01');
    expect(periodStart(new Date('2026-11-01T00:00:00Z'))).toBe('2026-11-01');
  });

  it('parses YYYY-MM strictly', () => {
    expect(parseMonth('2026-09')).toBe('2026-09-01');
    expect(parseMonth('2026-13')).toBeNull();
    expect(parseMonth('09-2026')).toBeNull();
  });
});
