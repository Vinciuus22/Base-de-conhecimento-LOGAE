import { closePool } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import { validatePasswordStrength } from '../lib/crypto.js';

const testUsers = process.env.SEED_TEST_USERS === 'true';
const adminEmail = process.env.SEED_ADMIN_EMAIL ?? (testUsers ? 'admin@exemplo.com' : undefined);
const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? (testUsers ? 'Admin12345!' : undefined);
if (!adminEmail || !adminPassword) {
  console.error('Defina SEED_ADMIN_EMAIL e SEED_ADMIN_PASSWORD para criar o administrador inicial.');
  process.exit(1);
}
const weak = validatePasswordStrength(adminPassword);
if (weak) {
  console.error(`SEED_ADMIN_PASSWORD inválida: ${weak}`);
  process.exit(1);
}
const demo = process.env.SEED_DEMO === 'true';
if (demo && process.env.NODE_ENV === 'production') {
  console.error('Os dados de demonstração não podem ser carregados em produção.');
  process.exit(1);
}

await runMigrations();
await seed({ adminEmail, adminPassword, demo, testUsers, demoPassword: process.env.SEED_DEMO_PASSWORD });
if (testUsers) console.log('Contas de teste: interno@teste.com / externo@teste.com (senha Teste@12345)');
console.log(`Seed concluído. Administrador: ${adminEmail}${demo ? ' (com dados de demonstração)' : ''}`);
await closePool();
