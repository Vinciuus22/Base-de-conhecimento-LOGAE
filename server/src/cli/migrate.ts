import { closePool } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { syncRbac } from '../db/rbac.js';

const applied = await runMigrations();
await syncRbac();
console.log(applied.length ? `Migrations aplicadas: ${applied.join(', ')}` : 'Nenhuma migration pendente.');
console.log('Perfis e permissões sincronizados.');
await closePool();
