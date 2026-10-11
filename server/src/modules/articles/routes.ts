import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ARTICLE_OPERATIONS } from '@shared/domain.js';
import { config } from '../../config.js';
import { getPool, query, queryOne, withTransaction } from '../../db/pool.js';
import { allowedVisibilities, isInternal, requireInternal, requirePermission, type AuthUser } from '../../auth/context.js';
import { anonymousAllowed, canEditArticle, canViewArticle, canViewArticleHistory } from '../../auth/policies.js';
import { audit } from '../../lib/audit.js';
import { AppError, forbidden, notFound } from '../../lib/errors.js';
import { dateRange, pageQuery, parse, uuid } from '../../lib/validate.js';
import {
  acquireLock,
  assertLockHeld,
  assertNoForeignLock,
  forceReleaseLock,
  getActiveLock,
  releaseLock,
  renewLock,
  serializeLock,
} from './locks.js';
import { searchArticles } from './search.js';
import {
  articleInputSchema,
  assertCanEdit,
  assertVersion,
  changeArticleStatus,
  createArticle,
  insertHistory,
  loadArticleForUpdate,
  publicationErrors,
  restoreVersion,
  serializeArticle,
  updateArticleContent,
  type ArticleRow,
} from './service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function findArticle(idOrSlug: string): Promise<ArticleRow | null> {
  return UUID_RE.test(idOrSlug)
    ? queryOne<ArticleRow>(`SELECT * FROM articles WHERE id = $1`, [idOrSlug])
    : queryOne<ArticleRow>(`SELECT * FROM articles WHERE slug = $1`, [idOrSlug]);
}

/** Carrega o artigo garantindo que o usuário pode vê-lo (404 caso contrário, sem revelar existência). */
async function loadVisibleArticle(user: AuthUser | null, idOrSlug: string): Promise<ArticleRow> {
  const a = await findArticle(idOrSlug);
  if (!a || !canViewArticle(user, a)) throw notFound('Artigo não encontrado.');
  return a;
}

/** Permissões contextuais do usuário sobre um artigo (para a interface; o backend revalida sempre). */
function articleCapabilities(user: AuthUser | null, a: ArticleRow) {
  const internal = isInternal(user);
  const p = user?.permissions;
  return {
    canEdit: internal && canEditArticle(user, a).ok,
    canPublish: internal && !!p?.has('articles.publish') && ['draft', 'unpublished'].includes(a.status),
    canUnpublish: internal && !!p?.has('articles.unpublish') && a.status === 'published',
    canArchive: internal && !!p?.has('articles.archive') && a.status !== 'archived',
    canUnarchive: internal && !!p?.has('articles.archive') && a.status === 'archived',
    canViewHistory: canViewArticleHistory(user, a),
    editBlockedReason: internal ? canEditArticle(user, a).reason ?? null : null,
  };
}

const saveSchema = articleInputSchema.extend({
  lockToken: z.string().uuid('Bloqueio de edição inválido.'),
  expectedVersion: z.number().int().min(1),
  finish: z.boolean().default(false),
});

const statusSchema = z.object({
  expectedVersion: z.number().int().min(1),
  lockToken: z.string().uuid().optional(),
});

export default async function articleRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Pesquisa (pública/interna conforme as permissões)
  // -------------------------------------------------------------------------
  app.get('/api/search', async (req) => {
    const q = parse(
      z.object({
        q: z.string().max(300).default(''),
        category: z.string().uuid().optional(),
        system: z.string().uuid().optional(),
        tag: z.string().max(80).optional(),
        visibility: z.enum(['internal', 'external']).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
      }).merge(pageQuery),
      req.query,
    );
    const range = dateRange(q.from, q.to);
    return searchArticles(req.auth, {
      q: q.q,
      categoryId: q.category,
      systemId: q.system,
      tag: q.tag,
      visibility: q.visibility,
      from: range.from,
      to: range.to,
      page: q.page,
      pageSize: q.pageSize,
    });
  });

  // -------------------------------------------------------------------------
  // Listagem interna (gestão de artigos)
  // -------------------------------------------------------------------------
  app.get('/api/articles', async (req) => {
    const user = requireInternal(req);
    const q = parse(
      z.object({
        status: z.enum(['draft', 'published', 'unpublished', 'archived']).optional(),
        visibility: z.enum(['internal', 'external']).optional(),
        category: z.string().uuid().optional(),
        system: z.string().uuid().optional(),
        author: z.enum(['me']).optional(),
        q: z.string().max(200).optional(),
      }).merge(pageQuery),
      req.query,
    );
    const p = user.permissions;
    const values: unknown[] = [allowedVisibilities(user), user.id];
    const canSeeOthersDrafts = p.has('articles.edit_others') || p.has('articles.publish') || p.has('articles.unpublish') || p.has('articles.archive');
    const canSeeOwnDrafts = p.has('articles.create') || p.has('articles.edit');
    // Regra de visibilidade espelhando canViewArticle(), aplicada no SQL.
    const where = [
      `a.visibility = ANY($1::text[])`,
      `(a.status = 'published' OR ${canSeeOthersDrafts ? 'true' : canSeeOwnDrafts ? 'a.author_id = $2' : 'false'})`,
    ];
    const add = (sql: string, v: unknown) => {
      values.push(v);
      where.push(sql.replace('?', `$${values.length}`));
    };
    if (q.status) add('a.status = ?', q.status);
    if (q.visibility) add('a.visibility = ?', q.visibility);
    if (q.category) add('a.category_id = ?', q.category);
    if (q.system) add('a.system_id = ?', q.system);
    if (q.author === 'me') where.push('a.author_id = $2');
    if (q.q) add(`(immutable_unaccent(lower(a.title)) LIKE '%' || immutable_unaccent(lower(?)) || '%')`, q.q);
    values.push(q.pageSize, (q.page - 1) * q.pageSize);
    const rows = await query(
      `SELECT a.id, a.slug, a.title, a.status, a.visibility, a.version, a.updated_at, a.published_at,
              (a.author_id = $2::uuid) AS is_mine, c.name AS category_name, s.name AS system_name, u.name AS author_name,
              l.user_id AS lock_user_id, lu.name AS lock_user_name, l.acquired_at AS lock_acquired_at,
              count(*) OVER () AS total
         FROM articles a
         LEFT JOIN categories c ON c.id = a.category_id
         LEFT JOIN systems s ON s.id = a.system_id
         JOIN users u ON u.id = a.author_id
         LEFT JOIN article_locks l ON l.article_id = a.id AND l.expires_at > now()
         LEFT JOIN users lu ON lu.id = l.user_id
        WHERE ${where.join(' AND ')}
        ORDER BY a.updated_at DESC
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return {
      total: rows.length ? Number(rows[0]!.total) : 0,
      items: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        title: r.title,
        status: r.status,
        visibility: r.visibility,
        version: r.version,
        updatedAt: r.updated_at,
        publishedAt: r.published_at,
        category: r.category_name,
        system: r.system_name,
        author: r.author_name,
        isMine: r.is_mine,
        lock: r.lock_user_id ? { holder: r.lock_user_name, acquiredAt: r.lock_acquired_at } : null,
      })),
    };
  });

  // -------------------------------------------------------------------------
  // Visualização
  // -------------------------------------------------------------------------
  app.get('/api/articles/:idOrSlug', async (req, reply) => {
    const { idOrSlug } = parse(z.object({ idOrSlug: z.string().min(1).max(200) }), req.params);
    const { preview } = parse(z.object({ preview: z.enum(['0', '1']).optional() }), req.query);
    const a = await loadVisibleArticle(req.auth, idOrSlug);
    if (a.status === 'published' && preview !== '1') {
      await query(`UPDATE articles SET view_count = view_count + 1 WHERE id = $1`, [a.id]);
    }
    const visibilities = allowedVisibilities(req.auth);
    const related = await query(
      `SELECT a2.id, a2.slug, a2.title, a2.summary, a2.updated_at
         FROM articles a2
        WHERE a2.id <> $1 AND a2.status = 'published' AND a2.visibility = ANY($2::text[])
          AND (a2.category_id = $3 OR a2.system_id = $4
               OR EXISTS (SELECT 1 FROM article_tags t1 JOIN article_tags t2 ON t1.tag_id = t2.tag_id
                           WHERE t1.article_id = $1 AND t2.article_id = a2.id))
        ORDER BY (a2.category_id = $3)::int + (a2.system_id = $4)::int DESC, a2.view_count DESC
        LIMIT 5`,
      [a.id, visibilities, a.category_id, a.system_id],
    );
    const lock = isInternal(req.auth) ? serializeLock(await getActiveLock(a.id), req.auth) : null;
    reply.header('Cache-Control', 'private, no-store');
    return {
      article: await serializeArticle(a),
      related: related.map((r) => ({ id: r.id, slug: r.slug, title: r.title, summary: r.summary, updatedAt: r.updated_at })),
      lock,
      capabilities: articleCapabilities(req.auth, a),
      publicationErrors: isInternal(req.auth) ? publicationErrors(a) : undefined,
    };
  });

  // -------------------------------------------------------------------------
  // Criação (rascunho)
  // -------------------------------------------------------------------------
  app.post('/api/articles', async (req, reply) => {
    const user = requirePermission(req, 'articles.create');
    const input = parse(articleInputSchema, req.body);
    const article = await withTransaction((client) => createArticle(user, input, client));
    await audit({ actorId: user.id, action: 'article.create', entityType: 'article', entityId: article.id, ip: req.ip });
    reply.code(201);
    return { article: await serializeArticle(article) };
  });

  // -------------------------------------------------------------------------
  // Bloqueio de edição
  // -------------------------------------------------------------------------
  app.get('/api/articles/:id/lock', async (req) => {
    const user = requireInternal(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    await loadVisibleArticle(user, id);
    return { lock: serializeLock(await getActiveLock(id), user) };
  });

  app.post('/api/articles/:id/lock', async (req) => {
    const user = requireInternal(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const article = await findArticle(id);
    if (!article) throw notFound('Artigo não encontrado.');
    assertCanEdit(user, article);
    const lock = await acquireLock(user, id, req.ip);
    return {
      lockToken: lock.lock_token,
      acquiredAt: lock.acquired_at,
      expiresAt: lock.expires_at,
      article: await serializeArticle(article),
    };
  });

  app.post('/api/articles/:id/lock/heartbeat', async (req) => {
    const user = requireInternal(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { lockToken } = parse(z.object({ lockToken: z.string().uuid() }), req.body);
    const article = await findArticle(id);
    if (!article) throw notFound('Artigo não encontrado.');
    // A autorização é revalidada a cada renovação: perda de permissão encerra a edição.
    const check = canEditArticle(user, article);
    if (!check.ok) {
      await releaseLock(user.id, id, lockToken, req.ip);
      throw forbidden(check.reason);
    }
    const lock = await renewLock(user, id, lockToken);
    return { expiresAt: lock.expires_at, version: article.version };
  });

  app.delete('/api/articles/:id/lock', async (req) => {
    const user = requireInternal(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { lockToken } = parse(z.object({ lockToken: z.string().uuid() }), req.body ?? {});
    return { released: await releaseLock(user.id, id, lockToken, req.ip) };
  });

  // Liberação ao fechar a aba (navigator.sendBeacon não envia cabeçalhos): validada pelo token secreto do bloqueio.
  app.post('/api/articles/:id/lock/beacon', async (req) => {
    const user = requireInternal(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    let body: unknown = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    const { lockToken } = parse(z.object({ lockToken: z.string().uuid() }), body);
    return { released: await releaseLock(user.id, id, lockToken, req.ip) };
  });

  // -------------------------------------------------------------------------
  // Salvamento (exige bloqueio válido + versão esperada + autorização)
  // -------------------------------------------------------------------------
  app.put('/api/articles/:id', async (req) => {
    const user = requireInternal(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(saveSchema, req.body);
    try {
      const result = await withTransaction(async (client) => {
        await assertLockHeld(client, user, id, body.lockToken);
        const article = await loadArticleForUpdate(client, id);
        assertCanEdit(user, article);
        assertVersion(article, body.expectedVersion);
        const r = await updateArticleContent(user, article, body, client);
        if (body.finish) {
          await client.query(`DELETE FROM article_locks WHERE article_id = $1 AND lock_token = $2`, [id, body.lockToken]);
        } else {
          await client.query(
            `UPDATE article_locks SET renewed_at = now(), expires_at = now() + make_interval(secs => $2) WHERE article_id = $1`,
            [id, config().LOCK_TTL_SECONDS],
          );
        }
        return r;
      });
      if (body.finish) await audit({ actorId: user.id, action: 'article.lock_released', entityType: 'article', entityId: id, data: { reason: 'save_and_finish' }, ip: req.ip });
      return { article: await serializeArticle(result.article), changed: result.changed, changes: result.changes, lockReleased: body.finish };
    } catch (err) {
      // Registra tentativas de salvamento rejeitadas por conflito no histórico do artigo.
      if (err instanceof AppError && err.statusCode === 409) {
        const current = await findArticle(id);
        if (current && canViewArticle(user, current)) {
          await insertHistory(getPool(), {
            articleId: id,
            userId: user.id,
            operation: 'save_rejected',
            version: current.version,
            changes: { reason: err.code, expectedVersion: body.expectedVersion },
            summary: err.message,
            result: 'failure',
          });
        }
      }
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // Publicação e demais alterações de status
  // -------------------------------------------------------------------------
  for (const action of ['publish', 'unpublish', 'archive', 'unarchive'] as const) {
    app.post(`/api/articles/:id/${action}`, async (req) => {
      const user = requireInternal(req);
      const { id } = parse(z.object({ id: uuid }), req.params);
      const body = parse(statusSchema, req.body);
      const updated = await withTransaction(async (client) => {
        const article = await loadArticleForUpdate(client, id);
        if (!canViewArticle(user, article)) throw notFound('Artigo não encontrado.');
        await assertNoForeignLock(client, user, id, body.lockToken);
        assertVersion(article, body.expectedVersion);
        return changeArticleStatus(user, article, action, client);
      });
      await audit({ actorId: user.id, action: `article.${action}`, entityType: 'article', entityId: id, data: { version: updated.version }, ip: req.ip });
      return { article: await serializeArticle(updated) };
    });
  }

  // -------------------------------------------------------------------------
  // Histórico e versões
  // -------------------------------------------------------------------------
  app.get('/api/articles/:id/history', async (req) => {
    const user = requireInternal(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const q = parse(
      z.object({
        user: z.string().uuid().optional(),
        operation: z.enum(ARTICLE_OPERATIONS).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
      }).merge(pageQuery),
      req.query,
    );
    const a = await findArticle(id);
    if (!a || !canViewArticleHistory(user, a)) throw notFound('Artigo não encontrado.');
    const range = dateRange(q.from, q.to);
    const rows = await query(
      `SELECT h.id, h.operation, h.version, h.changes, h.summary, h.result, h.created_at, u.id AS user_id, u.name AS user_name,
              count(*) OVER () AS total
         FROM article_history h JOIN users u ON u.id = h.user_id
        WHERE h.article_id = $1
          AND ($2::uuid IS NULL OR h.user_id = $2)
          AND ($3::text IS NULL OR h.operation = $3)
          AND ($4::timestamptz IS NULL OR h.created_at >= $4)
          AND ($5::timestamptz IS NULL OR h.created_at <= $5)
        ORDER BY h.created_at DESC, h.id DESC
        LIMIT $6 OFFSET $7`,
      [id, q.user ?? null, q.operation ?? null, range.from, range.to, q.pageSize, (q.page - 1) * q.pageSize],
    );
    const users = await query(
      `SELECT DISTINCT u.id, u.name FROM article_history h JOIN users u ON u.id = h.user_id WHERE h.article_id = $1 ORDER BY u.name`,
      [id],
    );
    return {
      article: { id: a.id, title: a.title, slug: a.slug, version: a.version, status: a.status },
      total: rows.length ? Number(rows[0]!.total) : 0,
      users,
      items: rows.map((r) => ({
        id: Number(r.id),
        operation: r.operation,
        version: r.version,
        changes: r.changes,
        summary: r.summary,
        result: r.result,
        createdAt: r.created_at,
        user: { id: r.user_id, name: r.user_name },
      })),
    };
  });

  app.get('/api/articles/:id/versions', async (req) => {
    const user = requireInternal(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const a = await findArticle(id);
    if (!a || !canViewArticleHistory(user, a)) throw notFound('Artigo não encontrado.');
    const rows = await query(
      `SELECT v.version, v.title, v.status, v.visibility, v.created_at, u.name AS created_by
         FROM article_versions v JOIN users u ON u.id = v.created_by
        WHERE v.article_id = $1 ORDER BY v.version DESC`,
      [id],
    );
    return { items: rows.map((r) => ({ version: r.version, title: r.title, status: r.status, visibility: r.visibility, createdAt: r.created_at, createdBy: r.created_by })) };
  });

  app.get('/api/articles/:id/versions/:version', async (req) => {
    const user = requireInternal(req);
    const { id, version } = parse(z.object({ id: uuid, version: z.coerce.number().int().min(1) }), req.params);
    const a = await findArticle(id);
    if (!a || !canViewArticleHistory(user, a)) throw notFound('Artigo não encontrado.');
    const v = await queryOne(
      `SELECT v.*, u.name AS created_by_name, c.name AS category_name, s.name AS system_name
         FROM article_versions v JOIN users u ON u.id = v.created_by
         LEFT JOIN categories c ON c.id = v.category_id LEFT JOIN systems s ON s.id = v.system_id
        WHERE v.article_id = $1 AND v.version = $2`,
      [id, version],
    );
    if (!v) throw notFound('Versão não encontrada.');
    return {
      version: {
        version: v.version,
        title: v.title,
        summary: v.summary,
        contentHtml: v.content_html,
        contentText: v.content_text,
        category: v.category_name,
        system: v.system_name,
        keywords: v.keywords,
        tags: v.tags,
        status: v.status,
        visibility: v.visibility,
        createdAt: v.created_at,
        createdBy: v.created_by_name,
      },
    };
  });

  app.post('/api/articles/:id/versions/:version/restore', async (req) => {
    const user = requireInternal(req);
    const { id, version } = parse(z.object({ id: uuid, version: z.coerce.number().int().min(1) }), req.params);
    const body = parse(statusSchema, req.body);
    const updated = await withTransaction(async (client) => {
      const article = await loadArticleForUpdate(client, id);
      if (!canViewArticle(user, article)) throw notFound('Artigo não encontrado.');
      await assertNoForeignLock(client, user, id, body.lockToken);
      assertVersion(article, body.expectedVersion);
      return restoreVersion(user, article, version, client);
    });
    await audit({ actorId: user.id, action: 'article.restore_version', entityType: 'article', entityId: id, data: { restoredVersion: version, newVersion: updated.version }, ip: req.ip });
    return { article: await serializeArticle(updated) };
  });

  // -------------------------------------------------------------------------
  // Administração de bloqueios
  // -------------------------------------------------------------------------
  app.get('/api/locks', async (req) => {
    requirePermission(req, 'locks.release');
    const rows = await query(
      `SELECT l.article_id, a.title, a.slug, u.id AS user_id, u.name AS user_name, l.acquired_at, l.renewed_at, l.expires_at,
              (l.expires_at <= now()) AS expired
         FROM article_locks l JOIN articles a ON a.id = l.article_id JOIN users u ON u.id = l.user_id
        ORDER BY l.acquired_at`,
    );
    return {
      items: rows.map((r) => ({
        articleId: r.article_id,
        title: r.title,
        slug: r.slug,
        holder: { id: r.user_id, name: r.user_name },
        acquiredAt: r.acquired_at,
        renewedAt: r.renewed_at,
        expiresAt: r.expires_at,
        expired: r.expired,
      })),
    };
  });

  app.post('/api/locks/:articleId/release', async (req) => {
    const admin = requirePermission(req, 'locks.release');
    const { articleId } = parse(z.object({ articleId: uuid }), req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(5, 'Informe o motivo da liberação (mínimo 5 caracteres).').max(500) }), req.body);
    const lock = await forceReleaseLock(admin, articleId, reason, req.ip);
    if (!lock) throw notFound('Não há bloqueio ativo para este artigo.');
    return { released: true };
  });

  // -------------------------------------------------------------------------
  // Página inicial
  // -------------------------------------------------------------------------
  app.get('/api/home', async (req) => {
    const user = req.auth;
    const vis = anonymousAllowed(user) ? allowedVisibilities(user) : [];
    const [categories, recent, popular, updates, systems] = await Promise.all([
      query(
        `SELECT c.id, c.name, c.slug, c.description, c.icon,
                (SELECT count(*) FROM articles a WHERE a.category_id = c.id AND a.status = 'published' AND a.visibility = ANY($1::text[]))::int AS article_count
           FROM categories c ORDER BY c.sort_order, c.name`,
        [vis],
      ),
      query(
        `SELECT a.id, a.slug, a.title, a.summary, a.updated_at, c.name AS category
           FROM articles a LEFT JOIN categories c ON c.id = a.category_id
          WHERE a.status = 'published' AND a.visibility = ANY($1::text[])
          ORDER BY a.updated_at DESC LIMIT 6`,
        [vis],
      ),
      query(
        `SELECT a.id, a.slug, a.title, a.summary, a.updated_at, a.view_count, c.name AS category
           FROM articles a LEFT JOIN categories c ON c.id = a.category_id
          WHERE a.status = 'published' AND a.visibility = ANY($1::text[]) AND a.view_count > 0
          ORDER BY a.view_count DESC LIMIT 6`,
        [vis],
      ),
      query(
        `SELECT u.id, u.jira_key, u.title, u.release, u.completed_at, u.published_at, s.name AS system
           FROM updates u LEFT JOIN systems s ON s.id = u.system_id
          WHERE u.status = 'published' AND u.visibility = ANY($1::text[])
          ORDER BY coalesce(u.completed_at, u.published_at) DESC LIMIT 5`,
        [vis],
      ),
      query(`SELECT id, name, slug FROM systems WHERE active ORDER BY name`),
    ]);
    const map = (r: Record<string, unknown>) => ({ id: r.id, slug: r.slug, title: r.title, summary: r.summary, updatedAt: r.updated_at, category: r.category });
    return {
      categories: categories.map((c) => ({ id: c.id, name: c.name, slug: c.slug, description: c.description, icon: c.icon, articleCount: c.article_count })),
      recent: recent.map(map),
      popular: popular.map(map),
      updates: updates.map((n) => ({ id: n.id, jiraKey: n.jira_key, title: n.title, release: n.release, date: n.completed_at ?? n.published_at, system: n.system })),
      systems,
    };
  });
}
