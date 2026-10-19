import type { Pool } from './db/pool.js';

// Injected so tests can move time across a month boundary.
export type Clock = () => Date;

export interface Deps {
  pool: Pool;
  clock: Clock;
  adminApiKey: string;
}
