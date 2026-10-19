import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PLAN_IDS } from '../src/domain/predefinedPlans.js';
import { api, consume, createAccount, resetData, setupTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let client: ReturnType<typeof api>;

beforeAll(async () => {
  env = await setupTestEnv();
});
beforeEach(async () => {
  await resetData(env.pool);
  env.clock.set(new Date('2026-10-31T23:59:30Z'));
  client = api(env.app, (await createAccount(env.app, 'Acme')).apiKey);
  await client.post('/v1/users', { userId: 'alice', planId: PLAN_IDS.premium });
});
afterAll(async () => {
  await env.pool.end();
});

describe('monthly periods', () => {
  it('starts every UTC month at zero and keeps previous months', async () => {
    expect((await consume(client, 'alice', 100)).body.period).toBe('2026-10');
    env.clock.set(new Date('2026-11-01T00:00:10Z'));
    const nov = await client.get('/v1/usage');
    expect(nov.body).toMatchObject({ period: '2026-11', isCurrentPeriod: true });
    expect(nov.body.account.used).toBe(0);
    expect((await consume(client, 'alice', 30)).body).toMatchObject({ period: '2026-11', accepted: true });
    const oct = await client.get('/v1/usage?month=2026-10');
    expect(oct.body).toMatchObject({ period: '2026-10', isCurrentPeriod: false });
    expect(oct.body.account).toMatchObject({ used: 100, remaining: null });
    const userOct = await client.get('/v1/users/alice/usage?month=2026-10');
    expect([userOct.body.user.used, userOct.body.account.used]).toEqual([100, 100]);
    expect((await client.get('/v1/usage/months')).body.items).toEqual([
      { period: '2026-11', used: 30 },
      { period: '2026-10', used: 100 },
    ]);
  });

  it('paginates history and filters by month and outcome', async () => {
    await consume(client, 'alice', 1);
    await consume(client, 'alice', 2);
    await consume(client, 'alice', 500);
    env.clock.set(new Date('2026-11-02T08:00:00Z'));
    await consume(client, 'alice', 4);
    const page1 = await client.get('/v1/requests?month=2026-10&limit=2');
    expect(page1.body.items.map((r: { units: number }) => r.units)).toEqual([500, 2]);
    expect(page1.body.nextCursor).not.toBeNull();
    const page2 = await client.get(`/v1/requests?month=2026-10&limit=2&cursor=${page1.body.nextCursor}`);
    expect(page2.body.items.map((r: { units: number }) => r.units)).toEqual([1]);
    expect(page2.body.nextCursor).toBeNull();
    const rejected = await client.get('/v1/requests?outcome=rejected');
    expect(rejected.body.items.map((r: { units: number }) => r.units)).toEqual([500]);
    expect((await client.get('/v1/requests?month=2026-13')).status).toBe(400);
  });
});
