import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { query, queryOne } from '../../db/pool.js';
import { requirePermission } from '../../auth/context.js';
import { audit } from '../../lib/audit.js';
import { safeEqual } from '../../lib/crypto.js';
import { AppError, notFound, serviceUnavailable } from '../../lib/errors.js';
import { dateRange, pageQuery, parse } from '../../lib/validate.js';
import { jiraConfigured } from '../updates/jira.js';
import { ingestWebhook, isSharedAccount, monitoredProjects, syncCards } from './service.js';

/** Todas as rotas deste módulo são somente de consulta (exceto a sincronização, que só LÊ do Jira). */
const keyParam = z.object({ key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*-\d+$/, 'Chave de card inválida.').transform((s) => s.toUpperCase()) });
const csv = z.string().max(500).optional().transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 30) : []));
const like = (s: string) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;

const CHANGE_AT = 'greatest(c.jira_updated_at, c.last_event_at)';

function serializeCard(r: Record<string, unknown>) {
  return {
    id: r.id,
    key: r.card_key,
    title: r.title,
    description: r.description,
    projectKey: r.project_key,
    projectName: r.project_name,
    boardName: r.board_name,
    status: r.status,
    statusCategory: r.status_category,
    priority: r.priority,
    issueType: r.issue_type,
    assignee: r.assignee_name,
    reporter: r.reporter_name,
    createdAt: r.jira_created_at,
    updatedAt: r.jira_updated_at,
    lastChangeAt: r.last_change_at,
    lastEventType: r.last_event_type,
    lastEventAuthor: r.last_event_author,
    lastEventShared: isSharedAccount((r.last_event_author as string) ?? null, null),
    lastSyncedAt: r.last_synced_at,
    historyComplete: r.history_complete,
    historyNote: r.history_note,
    url: r.url,
  };
}

async function syncInfo() {
  const [lastRun, lastOk, lastHook] = await Promise.all([
    queryOne(`SELECT kind, status, started_at, finished_at, cards_seen, events_added, error FROM jira_sync_runs ORDER BY started_at DESC LIMIT 1`),
    queryOne<{ finished_at: Date }>(`SELECT finished_at FROM jira_sync_runs WHERE status = 'success' ORDER BY started_at DESC LIMIT 1`),
    queryOne<{ received_at: Date }>(`SELECT received_at FROM jira_webhook_events WHERE status = 'processed' ORDER BY received_at DESC LIMIT 1`),
  ]);
  const times = [lastOk?.finished_at, lastHook?.received_at].filter((d): d is Date => !!d).map((d) => d.getTime());
  const lastSuccessAt = times.length ? new Date(Math.max(...times)) : null;
  const c = config();
  const stale = !lastSuccessAt || Date.now() - lastSuccessAt.getTime() > 24 * 3600_000 || lastRun?.status === 'failed';
  return {
    lastSuccessAt,
    lastRun: lastRun ? { kind: lastRun.kind, status: lastRun.status, startedAt: lastRun.started_at, finishedAt: lastRun.finished_at, cards: lastRun.cards_seen, events: lastRun.events_added, error: lastRun.error } : null,
    stale,
    state: !jiraConfigured() && !c.JIRA_WEBHOOK_SECRET ? 'not_configured' : lastRun?.status === 'failed' ? 'failed' : lastRun?.status === 'partial' ? 'partial' : stale ? 'stale' : 'ok',
    apiConfigured: jiraConfigured(),
    webhookConfigured: !!c.JIRA_WEBHOOK_SECRET,
    projects: monitoredProjects(),
    autoSyncMinutes: c.JIRA_CARDS_SYNC_MINUTES,
    webhookPath: '/api/integrations/jira/cards/webhook',
  };
}

export default async function cardsRoutes(app: FastifyInstance): Promise<void> {
  // Webhook (autenticado por segredo compartilhado; sem sessão)
  app.post('/api/integrations/jira/cards/webhook', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req) => {
    const secret = config().JIRA_WEBHOOK_SECRET;
    if (!secret) throw serviceUnavailable('JIRA_NOT_CONFIGURED', 'Integração com o Jira não configurada.');
    const given = req.headers['x-jira-secret'] ?? req.headers['x-webhook-secret'] ?? (req.query as Record<string, unknown>).secret;
    if (typeof given !== 'string' || !safeEqual(given, secret)) {
      await audit({ actorId: null, action: 'cards.webhook_rejected', ip: req.ip });
      throw new AppError(401, 'INVALID_SECRET', 'Segredo do webhook inválido.');
    }
    const result = await ingestWebhook((req.body ?? {}) as Record<string, unknown>);
    return { ok: true, result };
  });

  app.get('/api/cards', async (req) => {
    requirePermission(req, 'cards.view');
    const q = parse(
      z
        .object({
          q: z.string().max(200).optional(),
          project: csv,
          status: csv,
          assignee: z.string().max(200).optional(),
          author: z.string().max(200).optional(),
          eventType: csv,
          from: z.string().optional(),
          to: z.string().optional(),
          recent: z.enum(['1', '7', '30']).optional(),
        })
        .merge(pageQuery),
      req.query,
    );
    const values: unknown[] = [];
    const where: string[] = [];
    const add = (sql: string, v: unknown) => {
      values.push(v);
      where.push(sql.replaceAll('?', `$${values.length}`));
    };
    if (q.q) {
      add(
        `(c.card_key ILIKE ? OR unaccent(c.title) ILIKE unaccent(?) OR unaccent(c.description) ILIKE unaccent(?) OR unaccent(coalesce(c.assignee_name,'')) ILIKE unaccent(?)
          OR EXISTS (SELECT 1 FROM jira_card_events e WHERE e.card_id = c.id AND unaccent(coalesce(e.author_name,'')) ILIKE unaccent(?)))`,
        like(q.q),
      );
    }
    if (q.project.length) add('c.project_key = ANY(?::text[])', q.project);
    if (q.status.length) add('c.status = ANY(?::text[])', q.status);
    if (q.assignee) add(q.assignee === '__none__' ? 'c.assignee_name IS NULL AND ?::text IS NOT NULL' : 'c.assignee_name = ?', q.assignee);
    if (q.author) add('c.last_event_author = ?', q.author);
    if (q.eventType.length) add('c.last_event_type = ANY(?::text[])', q.eventType);
    const range = dateRange(q.from, q.to);
    if (range.from) add(`${CHANGE_AT} >= ?`, range.from);
    if (range.to) add(`${CHANGE_AT} <= ?`, range.to);
    if (q.recent) add(`${CHANGE_AT} >= now() - make_interval(days => ?::int)`, Number(q.recent));
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await queryOne<{ n: string }>(`SELECT count(*) AS n FROM jira_cards c ${whereSql}`, values);
    const rows = await query(
      `SELECT c.*, ${CHANGE_AT} AS last_change_at FROM jira_cards c ${whereSql}
        ORDER BY ${CHANGE_AT} DESC NULLS LAST, c.card_key DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, q.pageSize, (q.page - 1) * q.pageSize],
    );
    const [projects, statuses, assignees, authors, types] = await Promise.all([
      query<{ project_key: string; project_name: string | null; n: number }>(`SELECT project_key, max(project_name) AS project_name, count(*)::int AS n FROM jira_cards GROUP BY project_key ORDER BY project_key`),
      query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM jira_cards WHERE status IS NOT NULL GROUP BY status ORDER BY status`),
      query<{ assignee_name: string }>(`SELECT DISTINCT assignee_name FROM jira_cards WHERE assignee_name IS NOT NULL ORDER BY assignee_name`),
      query<{ last_event_author: string }>(`SELECT DISTINCT last_event_author FROM jira_cards WHERE last_event_author IS NOT NULL ORDER BY last_event_author`),
      query<{ last_event_type: string }>(`SELECT DISTINCT last_event_type FROM jira_cards WHERE last_event_type IS NOT NULL ORDER BY last_event_type`),
    ]);
    return {
      total: Number(total?.n ?? 0),
      items: rows.map(serializeCard),
      facets: {
        projects: projects.map((p) => ({ key: p.project_key, name: p.project_name, count: p.n })),
        statuses: statuses.map((s) => ({ name: s.status, count: s.n })),
        assignees: assignees.map((a) => a.assignee_name),
        authors: authors.map((a) => a.last_event_author),
        eventTypes: types.map((t) => t.last_event_type),
      },
      sync: await syncInfo(),
    };
  });

  app.get('/api/cards/sync-status', async (req) => {
    requirePermission(req, 'cards.view');
    return syncInfo();
  });

  app.post('/api/cards/sync', async (req) => {
    const user = requirePermission(req, 'cards.sync');
    const body = parse(z.object({ full: z.boolean().optional() }).default({}), req.body ?? {});
    const result = await syncCards({ full: body.full, triggeredBy: user.id });
    await audit({ actorId: user.id, action: 'cards.sync', data: { kind: result.kind, status: result.status, cards: result.cards, events: result.events, errors: result.errors.length }, ip: req.ip });
    return { ...result, sync: await syncInfo() };
  });

  app.get('/api/cards/:key', async (req) => {
    requirePermission(req, 'cards.view');
    const { key } = parse(keyParam, req.params);
    const r = await queryOne(`SELECT c.*, ${CHANGE_AT} AS last_change_at FROM jira_cards c WHERE c.card_key = $1`, [key]);
    if (!r) throw notFound('Card não encontrado.');
    return { card: serializeCard(r), sync: await syncInfo() };
  });

  app.get('/api/cards/:key/events', async (req) => {
    requirePermission(req, 'cards.view');
    const { key } = parse(keyParam, req.params);
    const card = await queryOne<{ id: string }>(`SELECT id FROM jira_cards WHERE card_key = $1`, [key]);
    if (!card) throw notFound('Card não encontrado.');
    const q = parse(
      z
        .object({
          q: z.string().max(200).optional(),
          author: z.string().max(200).optional(),
          type: csv,
          field: z.string().max(100).optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          order: z.enum(['asc', 'desc']).default('desc'),
        })
        .merge(pageQuery),
      req.query,
    );
    const values: unknown[] = [card.id];
    const where: string[] = ['e.card_id = $1'];
    const add = (sql: string, v: unknown) => {
      values.push(v);
      where.push(sql.replaceAll('?', `$${values.length}`));
    };
    if (q.q) add(`(unaccent(coalesce(e.comment_text,'')) ILIKE unaccent(?) OR unaccent(coalesce(e.from_value,'')) ILIKE unaccent(?) OR unaccent(coalesce(e.to_value,'')) ILIKE unaccent(?) OR unaccent(e.summary) ILIKE unaccent(?))`, like(q.q));
    if (q.author) add(q.author === '__none__' ? 'e.author_name IS NULL AND ?::text IS NOT NULL' : 'e.author_name = ?', q.author);
    if (q.type.length) add('e.event_type = ANY(?::text[])', q.type);
    if (q.field) add('e.field_name = ?', q.field);
    const range = dateRange(q.from, q.to);
    if (range.from) add('e.occurred_at >= ?', range.from);
    if (range.to) add('e.occurred_at <= ?', range.to);
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const dir = q.order === 'asc' ? 'ASC' : 'DESC';
    const total = await queryOne<{ n: string }>(`SELECT count(*) AS n FROM jira_card_events e ${whereSql}`, values);
    const rows = await query(
      `SELECT e.* FROM jira_card_events e ${whereSql} ORDER BY e.occurred_at ${dir}, e.synced_at ${dir}, e.event_key ${dir} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, q.pageSize, (q.page - 1) * q.pageSize],
    );
    const [authors, types, fields] = await Promise.all([
      query<{ author_name: string }>(`SELECT DISTINCT author_name FROM jira_card_events WHERE card_id = $1 AND author_name IS NOT NULL ORDER BY author_name`, [card.id]),
      query<{ event_type: string }>(`SELECT DISTINCT event_type FROM jira_card_events WHERE card_id = $1 ORDER BY event_type`, [card.id]),
      query<{ field_name: string }>(`SELECT DISTINCT field_name FROM jira_card_events WHERE card_id = $1 AND field_name IS NOT NULL ORDER BY field_name`, [card.id]),
    ]);
    return {
      total: Number(total?.n ?? 0),
      items: rows.map((e) => ({
        id: e.id,
        jiraEventId: e.jira_event_id,
        type: e.event_type,
        field: e.field_name,
        from: e.from_value,
        to: e.to_value,
        comment: e.comment_text,
        commentRestricted: e.comment_restricted,
        author: e.author_name,
        authorAccountId: e.author_account_id,
        authorShared: isSharedAccount(e.author_name, e.author_account_id),
        occurredAt: e.occurred_at,
        syncedAt: e.synced_at,
        summary: e.summary,
      })),
      facets: { authors: authors.map((a) => a.author_name), types: types.map((t) => t.event_type), fields: fields.map((f) => f.field_name) },
    };
  });
}
