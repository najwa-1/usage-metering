import request from 'supertest';
import type { Express } from 'express';
import { createPool, type Pool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedPredefinedPlans } from '../src/db/seed.js';
import { createApp } from '../src/http/app.js';

export const ADMIN_KEY = 'test-admin-key';
// Tests run against a real Postgres - locks and constraints are part of the logic, mocking them proves nothing.
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/metering_test';

export class TestClock {
  private current = new Date('2026-10-15T12:00:00Z');
  now = (): Date => new Date(this.current);
  set(date: Date): void {
    this.current = new Date(date);
  }
}

export interface TestEnv {
  pool: Pool;
  app: Express;
  clock: TestClock;
}

async function ensureTestDatabase(): Promise<void> {
  const url = new URL(TEST_DATABASE_URL);
  const name = url.pathname.slice(1);
  url.pathname = '/postgres';
  const admin = createPool(url.toString(), 1);
  try {
    const found = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (found.rowCount === 0) await admin.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
  } finally {
    await admin.end();
  }
}

export async function setupTestEnv(): Promise<TestEnv> {
  await ensureTestDatabase();
  const pool = createPool(TEST_DATABASE_URL, 30);
  await runMigrations(pool);
  await seedPredefinedPlans(pool);
  const clock = new TestClock();
  const app = createApp({ pool, clock: clock.now, adminApiKey: ADMIN_KEY });
  return { pool, app, clock };
}

export async function resetData(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE usage_requests, plan_assignments, user_usage, account_usage, users, accounts CASCADE');
  await seedPredefinedPlans(pool);
}

export async function createAccount(app: Express, name = 'Acme', planId?: string): Promise<{ id: string; apiKey: string }> {
  const res = await request(app).post('/v1/accounts').set('X-Admin-Key', ADMIN_KEY).send({ name, planId });
  if (res.status !== 201) throw new Error(`createAccount failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.account.id, apiKey: res.body.apiKey };
}

export function api(app: Express, apiKey: string) {
  return {
    get: (url: string) => request(app).get(url).set('X-API-Key', apiKey),
    post: (url: string, body: object) => request(app).post(url).set('X-API-Key', apiKey).send(body),
    put: (url: string, body: object) => request(app).put(url).set('X-API-Key', apiKey).send(body),
    patch: (url: string, body: object) => request(app).patch(url).set('X-API-Key', apiKey).send(body),
  };
}

export async function createPlan(
  client: ReturnType<typeof api>,
  plan: { name: string; scope: 'account' | 'user'; monthlyAllowance: number; maxUnitsPerRequest: number },
): Promise<string> {
  const res = await client.post('/v1/plans', plan);
  if (res.status !== 201) throw new Error(`createPlan failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id;
}

let counter = 0;
export function consume(client: ReturnType<typeof api>, userId: string, units: number, requestId = `req-${Date.now()}-${++counter}`) {
  return client.post('/v1/consume', { userId, units, requestId });
}
