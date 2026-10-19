export interface Config {
  databaseUrl: string;
  port: number;
  adminApiKey: string;
  dbPoolMax: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function loadConfig(): Config {
  return {
    databaseUrl: required('DATABASE_URL'),
    port: intFromEnv('PORT', 3000),
    adminApiKey: required('ADMIN_API_KEY'),
    dbPoolMax: intFromEnv('DB_POOL_MAX', 20), // 20 did best in the load tests, see perf/RESULTS.md
  };
}
