import { buildApp } from './app.js';
import { config } from './config.js';
import { closePool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { syncRbac } from './db/rbac.js';
import { startJobs } from './jobs.js';

async function main() {
  const cfg = config();
  if (process.env.MIGRATE_ON_START !== 'false') {
    await runMigrations();
    await syncRbac();
  }
  const app = await buildApp();
  const stopJobs = startJobs((msg, err) => app.log.error({ err }, msg));

  const shutdown = async (signal: string) => {
    app.log.info(`Encerrando (${signal})...`);
    stopJobs();
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: cfg.HOST, port: cfg.PORT });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
