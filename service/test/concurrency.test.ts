import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { api, createAccount, createPlan, resetData, setupTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let server: Server;
let baseUrl: string;

// Real server + parallel fetch calls, so requests actually overlap in the DB.
beforeAll(async () => {
  env = await setupTestEnv();
  server = env.app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  await resetData(env.pool);
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await env.pool.end();
});

async function post(apiKey: string, userId: string, units: number, requestId: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/v1/consume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ userId, units, requestId }),
  });
  return { status: res.status, body: await res.json() };
}

describe('concurrent requests', () => {
  it('never over-spends the shared account allowance', async () => {
    const account = await createAccount(env.app, 'Race');
    const client = api(env.app, account.apiKey);
    const plan = await createPlan(client, { name: 'Pool500', scope: 'account', monthlyAllowance: 500, maxUnitsPerRequest: 100 });
    await client.put('/v1/account/plan', { planId: plan });
    for (let i = 0; i < 10; i++) await client.post('/v1/users', { userId: `u${i}` });
    const results = await Promise.all(Array.from({ length: 100 }, (_, i) => post(account.apiKey, `u${i % 10}`, 10, `race-${i}`)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.accepted).length).toBe(50); // 500 / 10
    const usage = await client.get('/v1/usage?limit=100');
    expect(usage.body.account.used).toBe(500);
    const sumUsers = usage.body.users.items.reduce((sum: number, u: { used: number }) => sum + u.used, 0);
    expect(sumUsers).toBe(500);
    const db = await env.pool.query("SELECT COALESCE(SUM(units), 0)::int AS s FROM usage_requests WHERE accepted AND account_id = $1", [account.id]);
    expect(db.rows[0].s).toBe(500);
  });

  it('never over-spends a single user allowance', async () => {
    const account = await createAccount(env.app, 'Race2');
    const client = api(env.app, account.apiKey);
    const plan = await createPlan(client, { name: 'U95', scope: 'user', monthlyAllowance: 95, maxUnitsPerRequest: 10 });
    await client.post('/v1/users', { userId: 'solo', planId: plan });
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => post(account.apiKey, 'solo', 5, `solo-${i}`)));
    expect(results.filter((r) => r.body.accepted).length).toBe(19);
    expect((await client.get('/v1/users/solo')).body.usage).toMatchObject({ used: 95, remaining: 0 });
  });

  it('counts a request id once even when retries race each other', async () => {
    const account = await createAccount(env.app, 'Race3');
    const client = api(env.app, account.apiKey);
    await client.post('/v1/users', { userId: 'alice' });
    const results = await Promise.all(Array.from({ length: 20 }, () => post(account.apiKey, 'alice', 7, 'same-request')));
    expect(results.every((r) => r.status === 200 && r.body.accepted)).toBe(true);
    expect(results.filter((r) => !r.body.replayed).length).toBe(1);
    expect((await client.get('/v1/account')).body.usage.used).toBe(7);
  });

  it('keeps totals consistent while the plan changes under load', async () => {
    const account = await createAccount(env.app, 'Race4');
    const client = api(env.app, account.apiKey);
    const plan = await createPlan(client, { name: 'Moving', scope: 'account', monthlyAllowance: 300, maxUnitsPerRequest: 50 });
    await client.put('/v1/account/plan', { planId: plan });
    for (let i = 0; i < 5; i++) await client.post('/v1/users', { userId: `m${i}` });
    const requests = Array.from({ length: 150 }, (_, i) => post(account.apiKey, `m${i % 5}`, 3, `move-${i}`));
    const changes = [200, 400, 250, 600].map((monthlyAllowance) => client.patch(`/v1/plans/${plan}`, { monthlyAllowance }));
    const results = await Promise.all(requests);
    await Promise.all(changes);
    const acceptedUnits = results.filter((r) => r.body.accepted).length * 3;
    const counter = (await client.get('/v1/account')).body.usage.used;
    expect(counter).toBe(acceptedUnits);
    expect(counter).toBeLessThanOrEqual(600);
  });
});
