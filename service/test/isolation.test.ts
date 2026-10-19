import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, consume, createAccount, createPlan, resetData, setupTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let a: ReturnType<typeof api>;
let b: ReturnType<typeof api>;

beforeAll(async () => {
  env = await setupTestEnv();
});
beforeEach(async () => {
  await resetData(env.pool);
  a = api(env.app, (await createAccount(env.app, 'A')).apiKey);
  b = api(env.app, (await createAccount(env.app, 'B')).apiKey);
  expect((await a.post('/v1/users', { userId: 'alice' })).status).toBe(201);
  expect((await b.post('/v1/users', { userId: 'alice' })).status).toBe(201);
  expect((await b.post('/v1/users', { userId: 'bob' })).status).toBe(201);
});
afterAll(async () => {
  await env.pool.end();
});

describe('account isolation', () => {
  it('rejects consuming for a user of another account with 404', async () => {
    const res = await consume(a, 'bob', 1);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
  });

  it('keeps usage separate for users with the same id in different accounts', async () => {
    expect((await consume(a, 'alice', 15)).body.accepted).toBe(true);
    const bAlice = await b.get('/v1/users/alice');
    expect(bAlice.body.usage.used).toBe(0);
    expect((await b.get('/v1/usage')).body.account.used).toBe(0);
    expect((await a.get('/v1/usage')).body.account.used).toBe(15);
  });

  it('lists only the calling account users', async () => {
    const res = await a.get('/v1/users');
    expect(res.body.items.map((u: { userId: string }) => u.userId)).toEqual(['alice']);
  });

  it('hides custom plans of other accounts', async () => {
    const planId = await createPlan(b, { name: 'B Gold', scope: 'user', monthlyAllowance: 99_999, maxUnitsPerRequest: 999 });
    expect((await a.get(`/v1/plans/${planId}`)).status).toBe(404);
    expect((await a.put('/v1/users/alice/plan', { planId })).status).toBe(404);
    expect((await a.patch(`/v1/plans/${planId}`, { monthlyAllowance: 1 })).status).toBe(404);
    const list = await a.get('/v1/plans');
    expect(list.body.items.some((p: { id: string }) => p.id === planId)).toBe(false);
  });

  it('scopes request ids and history per account', async () => {
    const ra = await consume(a, 'alice', 5, 'shared-id');
    const rb = await consume(b, 'alice', 7, 'shared-id');
    expect(ra.body.replayed).toBe(false);
    expect(rb.body.replayed).toBe(false);
    const history = await a.get('/v1/requests');
    expect(history.body.items.map((r: { units: number }) => r.units)).toEqual([5]);
  });
});
