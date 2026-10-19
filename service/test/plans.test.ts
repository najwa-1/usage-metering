import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PLAN_IDS } from '../src/domain/predefinedPlans.js';
import { api, consume, createAccount, createPlan, resetData, setupTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let client: ReturnType<typeof api>;

beforeAll(async () => {
  env = await setupTestEnv();
});
beforeEach(async () => {
  await resetData(env.pool);
  client = api(env.app, (await createAccount(env.app, 'Acme')).apiKey);
  await client.post('/v1/users', { userId: 'alice' });
});
afterAll(async () => {
  await env.pool.end();
});

describe('plans', () => {
  it('provides predefined Starter, Pro, Basic and Premium plans', async () => {
    const res = await client.get('/v1/plans');
    const names = res.body.items.filter((p: { type: string }) => p.type === 'predefined').map((p: { name: string }) => p.name);
    expect(names.sort()).toEqual(['Basic', 'Premium', 'Pro', 'Starter']);
  });

  it('refuses to modify a predefined plan', async () => {
    const res = await client.patch(`/v1/plans/${PLAN_IDS.basic}`, { monthlyAllowance: 5 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PREDEFINED_PLAN_READ_ONLY');
  });

  it('creates, reads and updates a custom plan', async () => {
    const id = await createPlan(client, { name: 'Interns', scope: 'user', monthlyAllowance: 50, maxUnitsPerRequest: 5 });
    expect((await client.get(`/v1/plans/${id}`)).body).toMatchObject({ name: 'Interns', type: 'custom', monthlyAllowance: 50 });
    const updated = await client.patch(`/v1/plans/${id}`, { monthlyAllowance: 80 });
    expect(updated.body).toMatchObject({ monthlyAllowance: 80, maxUnitsPerRequest: 5, name: 'Interns' });
  });

  it('rejects duplicate names and scope changes', async () => {
    await createPlan(client, { name: 'Team', scope: 'user', monthlyAllowance: 50, maxUnitsPerRequest: 5 });
    const dup = await client.post('/v1/plans', { name: 'team', scope: 'user', monthlyAllowance: 1, maxUnitsPerRequest: 1 });
    expect(dup.status).toBe(409);
    const id = await createPlan(client, { name: 'Other', scope: 'user', monthlyAllowance: 50, maxUnitsPerRequest: 5 });
    expect((await client.patch(`/v1/plans/${id}`, { scope: 'account' })).status).toBe(400);
  });

  it('rejects assigning a plan of the wrong scope', async () => {
    const a = await client.put('/v1/account/plan', { planId: PLAN_IDS.basic });
    const b = await client.put('/v1/users/alice/plan', { planId: PLAN_IDS.starter });
    expect([a.body.error.code, b.body.error.code]).toEqual(['PLAN_SCOPE_MISMATCH', 'PLAN_SCOPE_MISMATCH']);
  });
});

describe('changing plans', () => {
  it('applies a custom plan update to the next request', async () => {
    const id = await createPlan(client, { name: 'Tight', scope: 'user', monthlyAllowance: 100, maxUnitsPerRequest: 5 });
    await client.put('/v1/users/alice/plan', { planId: id });
    expect((await consume(client, 'alice', 8)).body.accepted).toBe(false);
    await client.patch(`/v1/plans/${id}`, { maxUnitsPerRequest: 10 });
    expect((await consume(client, 'alice', 8)).body.accepted).toBe(true);
  });

  it('keeps separate totals for users sharing one plan', async () => {
    const id = await createPlan(client, { name: 'Shared', scope: 'user', monthlyAllowance: 10, maxUnitsPerRequest: 10 });
    await client.put('/v1/users/alice/plan', { planId: id });
    await client.post('/v1/users', { userId: 'bob', planId: id });
    expect((await consume(client, 'alice', 10)).body.accepted).toBe(true);
    expect((await consume(client, 'bob', 10)).body.accepted).toBe(true);
    expect((await consume(client, 'alice', 1)).body.rejection.rule).toBe('monthly_allowance');
  });

  it('preserves usage when switching plans', async () => {
    await consume(client, 'alice', 20);
    const res = await client.put('/v1/users/alice/plan', { planId: PLAN_IDS.premium });
    expect(res.body.usage).toMatchObject({ used: 20, remaining: 9_980 });
    const back = await client.put('/v1/users/alice/plan', { planId: PLAN_IDS.basic });
    expect(back.body.usage).toMatchObject({ used: 20, remaining: 980 });
  });

  it('shows zero remaining when an allowance drops below usage', async () => {
    const id = await createPlan(client, { name: 'Team', scope: 'account', monthlyAllowance: 1_000, maxUnitsPerRequest: 100 });
    await client.put('/v1/account/plan', { planId: id });
    await consume(client, 'alice', 20);
    await client.patch(`/v1/plans/${id}`, { monthlyAllowance: 10 });
    expect((await client.get('/v1/account')).body.usage).toMatchObject({ used: 20, remaining: 0 });
    expect((await consume(client, 'alice', 1)).body.rejection).toMatchObject({ scope: 'account', rule: 'monthly_allowance', remaining: 0 });
    await client.patch(`/v1/plans/${id}`, { monthlyAllowance: 25 });
    expect((await consume(client, 'alice', 5)).body.accepted).toBe(true);
  });

  it('preserves past request history after a plan change', async () => {
    const id = await createPlan(client, { name: 'Old', scope: 'user', monthlyAllowance: 100, maxUnitsPerRequest: 5 });
    await client.put('/v1/users/alice/plan', { planId: id });
    await consume(client, 'alice', 3);
    await client.patch(`/v1/plans/${id}`, { maxUnitsPerRequest: 50, monthlyAllowance: 500 });
    const history = await client.get('/v1/requests');
    expect(history.body.items[0].user).toMatchObject({ maxUnitsPerRequest: 5, monthlyAllowance: 100, used: 3 });
  });
});
