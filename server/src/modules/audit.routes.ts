import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { requirePermission } from '../auth/context.js';
import { dateRange, pageQuery, parse } from '../lib/validate.js';

/** Agrupa as ações de auditoria pelas telas do sistema (por prefixo da ação). */
const SCREENS: Array<[string, string[]]> = [
  ['Artigos', ['article.']],
  ['Categorias e sistemas', ['category.', 'system.', 'tag.', 'synonym.']],
  ['Comunicados', ['announcement.']],
  ['Atualizações', ['update.']],
  ['Atualizações dos Cards', ['cards.']],
  ['Integração de Clientes', ['integration.']],
  ['Documentos', ['document.']],
  ['Tickets', ['ticket.']],
  ['Usuários e permissões', ['user.', 'permission.', 'role.']],
  ['Empresas', ['company.']],
  ['Autenticação', ['auth.']],
];
export const screenOf = (action: string): string => SCREENS.find(([, p]) => p.some((x) => action.startsWith(x)))?.[0] ?? 'Outros';

export default async function auditRoutes(app: FastifyInstance): Promise<void> {
  // Somente leitura: não existem rotas para alterar ou excluir registros de auditoria.
  app.get('/api/audit', async (req) => {
    requirePermission(req, 'audit.view');
    const q = parse(
      z.object({
        action: z.string().max(80).optional(),
        actor: z.string().uuid().optional(),
        entityType: z.string().max(40).optional(),
        entityId: z.string().max(80).optional(),
        q: z.string().max(100).optional(),
        screen: z.string().max(60).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
      }).merge(pageQuery),
      req.query,
    );
    const range = dateRange(q.from, q.to);
    const prefixes = q.screen ? (SCREENS.find(([l]) => l === q.screen)?.[1] ?? []).map((p) => `${p}%`) : null;
    const like = q.q ? `%${q.q.replace(/[\\%_]/g, '\\$&')}%` : null;
    const rows = await query(
      `SELECT l.id, l.action, l.entity_type, l.entity_id, l.data, l.ip, l.created_at, u.id AS actor_id, u.name AS actor_name,
              count(*) OVER () AS total
         FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_id
        WHERE ($1::text IS NULL OR l.action LIKE $1 || '%')
          AND ($2::uuid IS NULL OR l.actor_id = $2)
          AND ($3::text IS NULL OR l.entity_type = $3)
          AND ($4::text IS NULL OR l.entity_id = $4)
          AND ($5::timestamptz IS NULL OR l.created_at >= $5)
          AND ($6::timestamptz IS NULL OR l.created_at <= $6)
          AND ($7::text[] IS NULL OR l.action LIKE ANY($7))
          AND ($8::text IS NULL OR l.action ILIKE $8 OR coalesce(l.entity_type, '') ILIKE $8 OR coalesce(l.entity_id, '') ILIKE $8 OR unaccent(coalesce(u.name, '')) ILIKE unaccent($8))
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT $9 OFFSET $10`,
      [q.action ?? null, q.actor ?? null, q.entityType ?? null, q.entityId ?? null, range.from, range.to, prefixes, like, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return {
      total: rows.length ? Number(rows[0]!.total) : 0,
      items: rows.map((r) => ({
        id: Number(r.id),
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        data: r.data,
        ip: r.ip,
        createdAt: r.created_at,
        screen: screenOf(r.action as string),
        actor: r.actor_id ? { id: r.actor_id, name: r.actor_name } : null,
      })),
      facets: {
        screens: SCREENS.map(([l]) => l),
        actors: await query(`SELECT DISTINCT u.id, u.name FROM audit_logs l JOIN users u ON u.id = l.actor_id ORDER BY u.name LIMIT 200`),
      },
    };
  });
}
