import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ANNOUNCEMENT_CATEGORIES } from '@shared/domain.js';
import { query, queryOne, withTransaction } from '../db/pool.js';
import { allowedVisibilities, requirePermission } from '../auth/context.js';
import { anonymousAllowed, canViewAnnouncement } from '../auth/policies.js';
import { audit } from '../lib/audit.js';
import { notFound, validationError } from '../lib/errors.js';
import { MAX_CONTENT_HTML_LENGTH, sanitizeRichHtml } from '../lib/sanitize.js';
import { htmlToText } from '../lib/text.js';
import { dateRange, pageQuery, parse, uuid } from '../lib/validate.js';
import { linkContentFiles } from './articles/service.js';

/**
 * Comunicados: avisos vinculados a uma ou mais plataformas (sistemas), com imagens e vídeos.
 * Somente usuários internos com `announcements.manage` os cadastram. Os publicados como
 * Externo são legíveis por clientes e visitantes; os Internos, somente pela equipe.
 */
const inputSchema = z.object({
  title: z.string().trim().min(3, 'Informe o título.').max(200),
  contentHtml: z.string().max(MAX_CONTENT_HTML_LENGTH).default(''),
  category: z.enum(ANNOUNCEMENT_CATEGORIES),
  visibility: z.enum(['internal', 'external'], { errorMap: () => ({ message: 'Selecione a visibilidade.' }) }),
  systemIds: z.array(z.string().uuid()).min(1, 'Vincule o comunicado a pelo menos uma plataforma.').max(30),
  relatedArticleIds: z.array(z.string().uuid()).max(10).default([]),
});

async function serialize(id: string) {
  const a = await queryOne(
    `SELECT n.*, u.name AS author_name FROM announcements n JOIN users u ON u.id = n.author_id WHERE n.id = $1`,
    [id],
  );
  if (!a) return null;
  const systems = await query<{ id: string; name: string }>(
    `SELECT s.id, s.name FROM announcement_systems x JOIN systems s ON s.id = x.system_id WHERE x.announcement_id = $1 ORDER BY s.name`,
    [id],
  );
  // Artigos relacionados: somente os que o leitor (interno) pode ver.
  const related = await query(
    `SELECT ar.id, ar.slug, ar.title FROM announcement_articles aa JOIN articles ar ON ar.id = aa.article_id
      WHERE aa.announcement_id = $1 AND ar.status = 'published'`,
    [id],
  );
  return {
    id: a.id,
    title: a.title,
    contentHtml: a.content_html,
    category: a.category,
    visibility: a.visibility,
    systems,
    status: a.status,
    author: a.author_name,
    publishedAt: a.published_at,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
    relatedArticles: related,
  };
}

async function setLinks(client: Parameters<typeof linkContentFiles>[4], id: string, systemIds: string[], articleIds: string[]) {
  const found = await client.query<{ id: string }>(`SELECT id FROM systems WHERE id = ANY($1::uuid[])`, [systemIds]);
  if (found.rows.length !== new Set(systemIds).size) throw validationError('Plataforma inválida.', { fields: { systemIds: 'Plataforma inválida.' } });
  await client.query(`DELETE FROM announcement_systems WHERE announcement_id = $1`, [id]);
  for (const sid of new Set(systemIds)) await client.query(`INSERT INTO announcement_systems (announcement_id, system_id) VALUES ($1, $2)`, [id, sid]);
  await client.query(`DELETE FROM announcement_articles WHERE announcement_id = $1`, [id]);
  for (const aid of articleIds) {
    await client.query(`INSERT INTO announcement_articles (announcement_id, article_id) SELECT $1, id FROM articles WHERE id = $2 ON CONFLICT DO NOTHING`, [id, aid]);
  }
}

export default async function announcementRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/announcements', async (req) => {
    const user = req.auth;
    const q = parse(
      z.object({
        q: z.string().max(200).optional(),
        system: z.string().uuid().optional(),
        category: z.enum(ANNOUNCEMENT_CATEGORIES).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        manage: z.enum(['0', '1']).default('0'),
      }).merge(pageQuery),
      req.query,
    );
    const manage = q.manage === '1' && !!user?.permissions.has('announcements.manage') && user.userType === 'internal';
    if (!manage && !anonymousAllowed(user)) return { total: 0, items: [] };
    const values: unknown[] = [];
    const where: string[] = [];
    const add = (sql: string, v: unknown) => {
      values.push(v);
      where.push(sql.replaceAll('?', `$${values.length}`));
    };
    if (!manage) {
      where.push(`n.status = 'published'`);
      add('n.visibility = ANY(?::text[])', allowedVisibilities(user));
    }
    if (q.q) add(`n.search_vector @@ websearch_to_tsquery('pt_unaccent', ?)`, q.q);
    if (q.system) add('EXISTS (SELECT 1 FROM announcement_systems x WHERE x.announcement_id = n.id AND x.system_id = ?)', q.system);
    if (q.category) add('n.category = ?', q.category);
    const range = dateRange(q.from, q.to);
    if (range.from) add('coalesce(n.published_at, n.created_at) >= ?', range.from);
    if (range.to) add('coalesce(n.published_at, n.created_at) <= ?', range.to);
    values.push(q.pageSize, (q.page - 1) * q.pageSize);
    const rows = await query(
      `SELECT n.id, n.title, n.category, n.visibility, n.status, n.published_at, n.created_at, left(n.content_text, 240) AS excerpt, u.name AS author_name,
              coalesce((SELECT array_agg(s.name ORDER BY s.name) FROM announcement_systems x JOIN systems s ON s.id = x.system_id WHERE x.announcement_id = n.id), '{}') AS systems,
              count(*) OVER () AS total
         FROM announcements n JOIN users u ON u.id = n.author_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY coalesce(n.published_at, n.created_at) DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return {
      total: rows.length ? Number(rows[0]!.total) : 0,
      items: rows.map((r) => ({
        id: r.id, title: r.title, category: r.category, visibility: r.visibility, status: r.status, publishedAt: r.published_at, createdAt: r.created_at,
        excerpt: r.excerpt, systems: r.systems, author: r.author_name,
      })),
    };
  });

  app.get('/api/announcements/:id', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const a = await queryOne<{ status: string; visibility: string }>(`SELECT status, visibility FROM announcements WHERE id = $1`, [id]);
    if (!a || !canViewAnnouncement(req.auth, a)) throw notFound('Comunicado não encontrado.');
    return { announcement: await serialize(id) };
  });

  app.post('/api/announcements', async (req, reply) => {
    const user = requirePermission(req, 'announcements.manage');
    const body = parse(inputSchema, req.body);
    const html = sanitizeRichHtml(body.contentHtml);
    const id = await withTransaction(async (client) => {
      const row = await queryOne<{ id: string }>(
        `INSERT INTO announcements (title, content_html, content_text, category, visibility, author_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [body.title, html, htmlToText(html), body.category, body.visibility, user.id],
        client,
      );
      await setLinks(client, row!.id, body.systemIds, body.relatedArticleIds);
      await linkContentFiles(html, 'announcement', row!.id, user.id, client);
      return row!.id;
    });
    await audit({ actorId: user.id, action: 'announcement.create', entityType: 'announcement', entityId: id, data: { title: body.title, systemIds: body.systemIds }, ip: req.ip });
    reply.code(201);
    return { announcement: await serialize(id) };
  });

  app.put('/api/announcements/:id', async (req) => {
    const user = requirePermission(req, 'announcements.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(inputSchema, req.body);
    const html = sanitizeRichHtml(body.contentHtml);
    await withTransaction(async (client) => {
      const row = await queryOne(
        `UPDATE announcements SET title = $2, content_html = $3, content_text = $4, category = $5, visibility = $6, updated_at = now() WHERE id = $1 RETURNING id`,
        [id, body.title, html, htmlToText(html), body.category, body.visibility],
        client,
      );
      if (!row) throw notFound('Comunicado não encontrado.');
      await setLinks(client, id, body.systemIds, body.relatedArticleIds);
      await linkContentFiles(html, 'announcement', id, user.id, client);
    });
    await audit({ actorId: user.id, action: 'announcement.update', entityType: 'announcement', entityId: id, data: { title: body.title, systemIds: body.systemIds }, ip: req.ip });
    return { announcement: await serialize(id) };
  });

  for (const action of ['publish', 'unpublish'] as const) {
    app.post(`/api/announcements/:id/${action}`, async (req) => {
      const user = requirePermission(req, 'announcements.manage');
      const { id } = parse(z.object({ id: uuid }), req.params);
      const row = await queryOne(
        action === 'publish'
          ? `UPDATE announcements SET status = 'published', published_at = now(), updated_at = now() WHERE id = $1 RETURNING id`
          : `UPDATE announcements SET status = 'draft', updated_at = now() WHERE id = $1 RETURNING id`,
        [id],
      );
      if (!row) throw notFound('Comunicado não encontrado.');
      await audit({ actorId: user.id, action: `announcement.${action}`, entityType: 'announcement', entityId: id, ip: req.ip });
      return { announcement: await serialize(id) };
    });
  }
}
