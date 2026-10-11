import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

export type Db = pg.Pool | pg.PoolClient;
export type QueryResultRow = pg.QueryResultRow;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const cfg = config();
    pool = new Pool({
      connectionString: cfg.DATABASE_URL,
      ssl: cfg.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
      max: 20,
      // Todas as datas são tratadas em UTC no banco.
      options: '-c timezone=UTC',
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  db: Db = getPool(),
): Promise<T[]> {
  const res = await db.query<T>(sql, params as unknown[]);
  return res.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  db: Db = getPool(),
): Promise<T | null> {
  const rows = await query<T>(sql, params, db);
  return rows[0] ?? null;
}

/** Executa a função em uma transação; faz rollback em caso de erro. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
