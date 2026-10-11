import { PERMISSION_DEFINITIONS, ROLE_DEFINITIONS } from '@shared/permissions.js';
import { withTransaction } from './pool.js';

/**
 * Sincroniza o catálogo de permissões e os perfis padrão com o banco.
 * Os perfis são modelos fixos; ajustes por pessoa são feitos com concessões
 * e revogações individuais (user_permissions), que não são alteradas aqui.
 */
export async function syncRbac(): Promise<void> {
  await withTransaction(async (client) => {
    for (const p of PERMISSION_DEFINITIONS) {
      await client.query(
        `INSERT INTO permissions (key, label, description, internal_only) VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description, internal_only = EXCLUDED.internal_only`,
        [p.key, p.label, p.description, p.internalOnly],
      );
    }
    for (const r of ROLE_DEFINITIONS) {
      const role = await client.query<{ id: string }>(
        `INSERT INTO roles (key, name, description, user_type) VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, user_type = EXCLUDED.user_type
         RETURNING id`,
        [r.key, r.name, r.description, r.userType],
      );
      const roleId = role.rows[0]!.id;
      await client.query(`DELETE FROM role_permissions WHERE role_id = $1 AND NOT (permission_key = ANY($2::text[]))`, [roleId, r.permissions]);
      for (const p of r.permissions) {
        await client.query(`INSERT INTO role_permissions (role_id, permission_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [roleId, p]);
      }
    }
  });
}
