import pg from 'pg';

/** Recria o banco de testes do zero antes da execução da suíte. */
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://kb:kb@localhost:5432/kb_test';
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA IF EXISTS public CASCADE');
  await client.query('CREATE SCHEMA public');
  await client.query(`DROP TEXT SEARCH CONFIGURATION IF EXISTS pt_unaccent`).catch(() => undefined);
  await client.end();

  process.env.DATABASE_URL = url;
  const { runMigrations } = await import('../src/db/migrate.js');
  const { syncRbac } = await import('../src/db/rbac.js');
  const { closePool } = await import('../src/db/pool.js');
  await runMigrations(() => undefined);
  await syncRbac();
  await closePool();
}
