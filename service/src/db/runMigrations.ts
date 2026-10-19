import { createPool } from './pool.js';
import { runMigrations } from './migrate.js';
import { seedPredefinedPlans } from './seed.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const pool = createPool(url, 2);
const applied = await runMigrations(pool);
await seedPredefinedPlans(pool);
console.log(`migrations applied: ${applied.length ? applied.join(', ') : 'none (up to date)'}`);
await pool.end();
