import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ANNOUNCEMENT_CATEGORIES } from '@shared/domain.js';
import { query, queryOne, withTransaction } from '../db/pool.js';
import { allowedVisibilities, requirePermission } from '../auth/context.js';
import { anonymousAllowed, canViewAnnouncement } from '../auth/policies.js';
import { audit } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { MAX_CONTENT_HTML_LENGTH, sanitizeRichHtml } from '../lib/sanitize.js';
import { htmlToText } from '../lib/text.js';
import { dateRange, pageQuery, parse, uuid } from '../lib/validate.js';
import { linkContentFiles } from './articles/service.js';

const inputSchema = z.object({
  title: z.string().trim().min(3, 'Informe o título.').max(200),
  contentHtml: z.string().max(MAX_CONTENT_HTML_LENGTH).default(''),
  category: z.enum(ANNOUNCEMENT_CATEGORIES),
  systemId: z.string().uuid().nullable().optional(),
  visibility: z.enum(['internal', 'external'], { errorMap: () => ({ message: 'Defina a visibilidade.' }) }),
  relatedArticleIds: z.array(z.string().uuid()).max(10).default([]),
});

async function serialize(id: string, viewer: Parameters<typeof allowedVisibilities>[0]) {
  const a = await queryOne(
    `SELECT n.*, s.name AS system_name, u.name AS author_name FROM announcements n
       LEFT JOIN systems s ON s.id = n.system_id JOIN users u ON u.id = n.author_id WHERE n.id = $1`,
    [id],
  );
  if (!a) return null;
  // Artigos relacionados: somente os que o leitor pode ver.
  const related = await query(
    `SELECT ar.id, ar.slug, ar.title FROM announcement_articles aa JOIN articles ar ON ar.id = aa.article_id
      WHERE aa.announcement_id = $1 AND ar.status = 'published' AND ar.visibility = ANY($2::text[])`,
    [id, allowedVisibilities(viewer)],
  );
  return {
    id: a.id,
    title: a.title,
    contentHtml: a.content_html,
    category: a.category,
    system: a.system_id ? { id: a.system_id, name: a.system_name } : null,
    visibility: a.visibility,
    status: a.status,
    author: a.author_name,
    publishedAt: a.published_at,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
    relatedArticles: related,
  };
}

async function setRelated(client: Parameters<typeof linkContentFiles>[4], id: string, articleIds: string[]) {
  await client.query(`DELETE FROM announcement_articles WHERE announcement_id = $1`, [id]);
  for (const aid of articleIds) {
    await client.query(
      `INSERT INTO announcement_articles (announcement_id, article_id) SELECT $1, id FROM articles WHERE id = $2 ON CONFLICT DO NOTHING`,
      [id, aid],
    );
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
    const manage = q.manage === '1' && !!user?.permissions.has('announcements.manage');
    const values: unknown[] = [];
    const where: string[] = [];
    const add = (sql: string, v: unknown) => {
      values.push(v);
      where.push(sql.replaceAll('?', `$${values.length}`));
    };
    if (!manage) {
      if (!anonymousAllowed(user)) return { total: 0, items: [] };
      where.push(`n.status = 'published'`);
      add('n.visibility = ANY(?::text[])', allowedVisibilities(user));
    }
    if (q.q) add(`n.search_vector @@ websearch_to_tsquery('pt_unaccent', ?)`, q.q);
    if (q.system) add('n.system_id = ?', q.system);
    if (q.category) add('n.category = ?', q.category);
    const range = dateRange(q.from, q.to);
    if (range.from) add('coalesce(n.published_at, n.created_at) >= ?', range.from);
    if (range.to) add('coalesce(n.published_at, n.created_at) <= ?', range.to);
    values.push(q.pageSize, (q.page - 1) * q.pageSize);
    const rows = await query(
      `SELECT n.id, n.title, n.category, n.visibility, n.status, n.published_at, n.created_at, left(n.content_text, 240) AS excerpt,
              s.name AS system_name, u.name AS author_name, count(*) OVER () AS total
         FROM announcements n LEFT JOIN systems s ON s.id = n.system_id JOIN users u ON u.id = n.author_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY coalesce(n.published_at, n.created_at) DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return {
      total: rows.length ? Number(rows[0]!.total) : 0,
      items: rows.map((r) => ({
        id: r.id, title: r.title, category: r.category, visibility: r.visibility, status: r.status, publishedAt: r.published_at,
        createdAt: r.created_at, excerpt: r.excerpt, system: r.system_name, author: r.author_name,
      })),
    };
  });

  app.get('/api/announcements/:id', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const a = await queryOne<{ status: string; visibility: string }>(`SELECT status, visibility FROM announcements WHERE id = $1`, [id]);
    if (!a || !canViewAnnouncement(req.auth, a)) throw notFound('Comunicado não encontrado.');
    return { announcement: await serialize(id, req.auth) };
  });

  app.post('/api/announcements', async (req, reply) => {
    const user = requirePermission(req, 'announcements.manage');
    const body = parse(inputSchema, req.body);
    const html = sanitizeRichHtml(body.contentHtml);
    const id = await withTransaction(async (client) => {
      const row = await queryOne<{ id: string }>(
        `INSERT INTO announcements (title, content_html, content_text, category, system_id, visibility, author_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [body.title, html, htmlToText(html), body.category, body.systemId ?? null, body.visibility, user.id],
        client,
      );
      await setRelated(client, row!.id, body.relatedArticleIds);
      await linkContentFiles(html, 'announcement', row!.id, user.id, client);
      return row!.id;
    });
    await audit({ actorId: user.id, action: 'announcement.create', entityType: 'announcement', entityId: id, data: { title: body.title, visibility: body.visibility }, ip: req.ip });
    reply.code(201);
    return { announcement: await serialize(id, user) };
  });

  app.put('/api/announcements/:id', async (req) => {
    const user = requirePermission(req, 'announcements.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(inputSchema, req.body);
    const html = sanitizeRichHtml(body.contentHtml);
    await withTransaction(async (client) => {
      const row = await queryOne(
        `UPDATE announcements SET title = $2, content_html = $3, content_text = $4, category = $5, system_id = $6, visibility = $7, updated_at = now()
          WHERE id = $1 RETURNING id`,
        [id, body.title, html, htmlToText(html), body.category, body.systemId ?? null, body.visibility],
        client,
      );
      if (!row) throw notFound('Comunicado não encontrado.');
      await setRelated(client, id, body.relatedArticleIds);
      await linkContentFiles(html, 'announcement', id, user.id, client);
    });
    await audit({ actorId: user.id, action: 'announcement.update', entityType: 'announcement', entityId: id, data: { title: body.title, visibility: body.visibility }, ip: req.ip });
    return { announcement: await serialize(id, user) };
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
      return { announcement: await serialize(id, user) };
    });
  }
}
