import pg from 'pg';

// bigint -> number (our values stay far below 2^53)
pg.types.setTypeParser(20, (value: string) => Number(value));
// Keep DATE as 'YYYY-MM-DD'. Turning it into a JS Date applies the local timezone and can
// shift the month, which is exactly what we don't want for monthly periods.
pg.types.setTypeParser(1082, (value: string) => value);

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

export function createPool(connectionString: string, max = 20): Pool {
  return new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
  });
}

export async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
