import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from './pool.js';

function migrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Em desenvolvimento: src/db/migrations. No build (dist/): dist/migrations.
  const candidates = [path.join(here, 'migrations'), path.join(here, '..', 'migrations'), path.join(here, 'db', 'migrations')];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error('Diretório de migrations não encontrado');
  return found;
}

/** Aplica as migrations pendentes, em ordem, cada uma em sua própria transação. */
export async function runMigrations(log: (msg: string) => void = console.log): Promise<string[]> {
  const pool = getPool();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    // Evita execução concorrente das migrations por múltiplas instâncias.
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const dir = migrationsDir();
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(path.join(dir, file), 'utf8');
      log(`Aplicando migration ${file}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Falha na migration ${file}: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    client.release();
  }
  return applied;
}
