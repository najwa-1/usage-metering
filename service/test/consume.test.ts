import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { PLAN_IDS } from '../src/domain/predefinedPlans.js';
import { api, consume, createAccount, createPlan, resetData, setupTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let client: ReturnType<typeof api>;
let apiKey: string;

beforeAll(async () => {
  env = await setupTestEnv();
});
beforeEach(async () => {
  await resetData(env.pool);
  apiKey = (await createAccount(env.app, 'Docs Inc', PLAN_IDS.starter)).apiKey;
  client = api(env.app, apiKey);
  await client.post('/v1/users', { userId: 'alice', planId: PLAN_IDS.basic });
});
afterAll(async () => {
  await env.pool.end();
});

describe('brief examples (account 10,000/100, user 1,000/20)', () => {
  it('rejects 25 units by the user per-request rule and consumes nothing', async () => {
    const res = await consume(client, 'alice', 25);
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(false);
    expect(res.body.rejection).toMatchObject({ scope: 'user', rule: 'max_units_per_request', limit: 20, requested: 25 });
    expect(res.body.user.used).toBe(0);
    expect(res.body.account.used).toBe(0);
    expect((await client.get('/v1/requests?outcome=rejected')).body.items).toHaveLength(1);
  });

  it('accepts 10 units and adds them to both the user and the account', async () => {
    const res = await consume(client, 'alice', 10);
    expect(res.body.accepted).toBe(true);
    expect(res.body.user).toMatchObject({ used: 10, remaining: 990 });
    expect(res.body.account).toMatchObject({ used: 10, remaining: 9_990 });
    const usage = await client.get('/v1/usage');
    expect(usage.body.account.used).toBe(10);
    expect(usage.body.users.items[0]).toMatchObject({ userId: 'alice', used: 10, remaining: 990 });
  });

  it('rejects 10 units when the account has only 5 left, even if the user has plenty', async () => {
    const small = await createPlan(client, { name: 'Small', scope: 'account', monthlyAllowance: 100, maxUnitsPerRequest: 100 });
    await client.put('/v1/account/plan', { planId: small });
    await client.post('/v1/users', { userId: 'bob', planId: PLAN_IDS.premium });
    expect((await consume(client, 'bob', 95)).body.accepted).toBe(true);
    const res = await consume(client, 'alice', 10);
    expect(res.body.accepted).toBe(false);
    expect(res.body.rejection).toMatchObject({ scope: 'account', rule: 'monthly_allowance', remaining: 5 });
    expect(res.body.user.remaining).toBe(1_000);
  });
});

describe('input validation', () => {
  it.each([0, -5, 1.5, '10', null])('rejects units=%s with 400', async (units) => {
    const res = await client.post('/v1/consume', { userId: 'alice', units, requestId: 'r-1' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requires a requestId', async () => {
    const res = await client.post('/v1/consume', { userId: 'alice', units: 1 });
    expect(res.status).toBe(400);
  });

  it('answers malformed JSON with 400', async () => {
    const res = await request(env.app).post('/v1/consume').set('X-API-Key', apiKey).set('Content-Type', 'application/json').send('{"userId":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('answers an unknown user with 404', async () => {
    const res = await consume(client, 'nobody', 1);
    expect(res.status).toBe(404);
  });
});

describe('retries with the same requestId', () => {
  it('returns the stored decision and does not double count', async () => {
    const first = await consume(client, 'alice', 10, 'retry-1');
    const second = await consume(client, 'alice', 10, 'retry-1');
    expect(first.body.accepted).toBe(true);
    expect(second.body.replayed).toBe(true);
    expect(second.body.user.used).toBe(10);
    expect((await client.get('/v1/users/alice')).body.usage.used).toBe(10);
    expect((await client.get('/v1/requests')).body.items).toHaveLength(1);
  });

  it('replays rejections too', async () => {
    await consume(client, 'alice', 25, 'retry-2');
    const again = await consume(client, 'alice', 25, 'retry-2');
    expect(again.body).toMatchObject({ accepted: false, replayed: true });
  });

  it('rejects reusing a requestId with different units', async () => {
    await consume(client, 'alice', 10, 'retry-3');
    const res = await consume(client, 'alice', 11, 'retry-3');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REQUEST_ID_REUSED');
  });
});

describe('explaining decisions', () => {
  it('exposes the current plans and limits', async () => {
    const account = await client.get('/v1/account');
    expect(account.body.plan).toMatchObject({ name: 'Starter', monthlyAllowance: 10_000, maxUnitsPerRequest: 100 });
    const user = await client.get('/v1/users/alice');
    expect(user.body.plan).toMatchObject({ name: 'Basic', monthlyAllowance: 1_000, maxUnitsPerRequest: 20 });
  });

  it('lists every violated rule', async () => {
    const res = await consume(client, 'alice', 150);
    expect(res.body.violations.map((v: { scope: string }) => v.scope)).toEqual(['user', 'account']);
  });
});
