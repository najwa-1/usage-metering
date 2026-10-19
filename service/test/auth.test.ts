import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ADMIN_KEY, api, createAccount, resetData, setupTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await setupTestEnv();
});
beforeEach(async () => {
  await resetData(env.pool);
});
afterAll(async () => {
  await env.pool.end();
});

describe('API key authentication', () => {
  it('rejects a missing API key', async () => {
    const res = await request(env.app).get('/v1/account');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('MISSING_API_KEY');
  });

  it('rejects an invalid API key', async () => {
    const res = await api(env.app, 'mk_not-a-real-key').post('/v1/consume', { userId: 'a', units: 1, requestId: 'r' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_API_KEY');
  });

  it('accepts a valid key in either header', async () => {
    const account = await createAccount(env.app, 'Acme');
    const a = await api(env.app, account.apiKey).get('/v1/account');
    const b = await request(env.app).get('/v1/account').set('Authorization', `Bearer ${account.apiKey}`);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.id).toBe(account.id);
    expect(JSON.stringify(a.body)).not.toContain(account.apiKey);
  });

  it('stores only a hash of the key', async () => {
    const account = await createAccount(env.app, 'Acme');
    const row = await env.pool.query('SELECT api_key_hash FROM accounts WHERE id = $1', [account.id]);
    expect(row.rows[0].api_key_hash).not.toBe(account.apiKey);
    expect(row.rows[0].api_key_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('admin key', () => {
  it('requires the admin key to create accounts', async () => {
    const missing = await request(env.app).post('/v1/accounts').send({ name: 'X' });
    const wrong = await request(env.app).post('/v1/accounts').set('X-Admin-Key', 'nope').send({ name: 'X' });
    const right = await request(env.app).post('/v1/accounts').set('X-Admin-Key', ADMIN_KEY).send({ name: 'X' });
    expect([missing.status, wrong.status, right.status]).toEqual([401, 401, 201]);
    expect(right.body.apiKey).toMatch(/^mk_/);
  });

  it('does not accept an account API key as admin key', async () => {
    const account = await createAccount(env.app, 'Acme');
    const res = await request(env.app).post('/v1/accounts').set('X-Admin-Key', account.apiKey).send({ name: 'Y' });
    expect(res.status).toBe(401);
  });
});
