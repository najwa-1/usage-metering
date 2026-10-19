import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from './pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function findMigrationsDir(): Promise<string> {
  // works both from src/ (tsx) and from dist/ (compiled)
  const candidates = [path.resolve(here, '../../migrations'), path.resolve(here, '../../../migrations')];
  for (const dir of candidates) {
    try {
      await readdir(dir);
      return dir;
    } catch {
      // not here, try the next one
    }
  }
  throw new Error('migrations directory not found');
}

export async function runMigrations(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    // in case two instances start at the same time
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const done = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(done.rows.map((row) => row.name));
    const dir = await findMigrationsDir();
    const files = (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort();
    const newlyApplied: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        newlyApplied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return newlyApplied;
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    client.release();
  }
}
