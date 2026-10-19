import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { seedPredefinedPlans } from './db/seed.js';
import { createApp } from './http/app.js';

// In docker compose the DB can still be starting when we boot.
async function waitForDatabase(query: () => Promise<unknown>, attempts = 30): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await query();
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      console.log(`database not ready (attempt ${attempt}/${attempts}), retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

const config = loadConfig();
const pool = createPool(config.databaseUrl, config.dbPoolMax);
await waitForDatabase(() => pool.query('SELECT 1'));
const applied = await runMigrations(pool);
console.log(`migrations: ${applied.length ? applied.join(', ') : 'up to date'}`);
await seedPredefinedPlans(pool);
const app = createApp({ pool, clock: () => new Date(), adminApiKey: config.adminApiKey });
const server = app.listen(config.port, () => console.log(`usage metering service listening on port ${config.port}`));

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  server.close(() => void pool.end().then(() => process.exit(0)));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
