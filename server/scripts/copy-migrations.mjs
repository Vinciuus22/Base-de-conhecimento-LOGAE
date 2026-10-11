import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/migrations', { recursive: true });
cpSync('src/db/migrations', 'dist/migrations', { recursive: true });
console.log('Migrations copiadas para dist/migrations');
