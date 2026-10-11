import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { requirePermission } from '../auth/context.js';
import { dateRange, pageQuery, parse } from '../lib/validate.js';

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
        from: z.string().optional(),
        to: z.string().optional(),
      }).merge(pageQuery),
      req.query,
    );
    const range = dateRange(q.from, q.to);
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
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT $7 OFFSET $8`,
      [q.action ?? null, q.actor ?? null, q.entityType ?? null, q.entityId ?? null, range.from, range.to, q.pageSize, (q.page - 1) * q.pageSize],
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
        actor: r.actor_id ? { id: r.actor_id, name: r.actor_name } : null,
      })),
    };
  });
}
