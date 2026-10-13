import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../config.js';
import { query, queryOne } from '../../db/pool.js';
import { allowedVisibilities, requirePermission } from '../../auth/context.js';
import { anonymousAllowed } from '../../auth/policies.js';
import { audit } from '../../lib/audit.js';
import { safeEqual } from '../../lib/crypto.js';
import { AppError, notFound, serviceUnavailable } from '../../lib/errors.js';
import { dateRange, pageQuery, parse, uuid } from '../../lib/validate.js';
import { fetchIssueWithNames, jiraConfigured, processIssue, resolveFieldKey, syncFromJira, type JiraIssue } from './jira.js';

const SELECT = `
  SELECT u.id, u.jira_key, u.jira_url, u.title, u.description_text, u.release, u.audience_raw, u.visibility, u.status,
         u.manual_override, u.jira_status, u.completed_at, u.published_at, u.updated_at, s.id AS system_id, s.name AS system_name`;

function serialize(r: Record<string, unknown>, manage: boolean, internal = manage) {
  return {
    id: r.id,
    ...(internal ? { jiraKey: r.jira_key, jiraUrl: r.jira_url, visibility: r.visibility } : {}),
    title: r.title,
    description: r.description_text,
    release: r.release,
    system: r.system_id ? { id: r.system_id, name: r.system_name } : null,
    completedAt: r.completed_at,
    publishedAt: r.published_at,
    updatedAt: r.updated_at,
    ...(manage ? { status: r.status, manualOverride: r.manual_override, audienceRaw: r.audience_raw, jiraStatus: r.jira_status } : {}),
  };
}

function authorizedWebhook(headerSecret: unknown, querySecret: unknown): boolean {
  const secret = config().JIRA_WEBHOOK_SECRET;
  if (!secret) return false;
  const given = typeof headerSecret === 'string' ? headerSecret : typeof querySecret === 'string' ? querySecret : '';
  return !!given && safeEqual(given, secret);
}

function extractIssues(body: unknown): JiraIssue[] {
  const b = (body ?? {}) as Record<string, unknown>;
  const candidates: unknown[] = Array.isArray(b.issues) ? b.issues : b.issue ? [b.issue] : b.key && b.fields ? [b] : [];
  return candidates.filter((i): i is JiraIssue => !!i && typeof (i as JiraIssue).key === 'string' && typeof (i as JiraIssue).fields === 'object');
}

export default async function updatesRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Webhook do Jira (autenticado por segredo compartilhado; sem cookie de sessão)
  // -------------------------------------------------------------------------
  app.post('/api/integrations/jira/webhook', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    if (!config().JIRA_WEBHOOK_SECRET) throw serviceUnavailable('JIRA_NOT_CONFIGURED', 'Integração com o Jira não configurada.');
    const q = req.query as Record<string, unknown>;
    if (!authorizedWebhook(req.headers['x-jira-secret'] ?? req.headers['x-webhook-secret'], q.secret)) {
      await audit({ actorId: null, action: 'update.webhook_rejected', ip: req.ip });
      throw new AppError(401, 'INVALID_SECRET', 'Segredo do webhook inválido.');
    }
    const issues = extractIssues(req.body);
    if (!issues.length) throw new AppError(400, 'NO_ISSUE', 'Payload sem tarefa do Jira.');
    const results: Record<string, string> = {};
    for (let issue of issues.slice(0, 50)) {
      const c = config();
      // Campos configurados por NOME exigem o mapa de nomes; busca na API se necessário.
      const needNames =
        !issue.names &&
        [c.JIRA_RELEASE_FIELD, c.JIRA_AUDIENCE_FIELD].some((f) => resolveFieldKey(f, issue.fields) === null && !/^customfield_\d+$/.test(f));
      if (needNames) {
        const full = await fetchIssueWithNames(issue.key);
        if (full) issue = full;
      }
      results[issue.key] = await processIssue(issue, 'webhook');
    }
    return { ok: true, results };
  });

  // -------------------------------------------------------------------------
  // Consulta (somente leitura para externos)
  // -------------------------------------------------------------------------
  app.get('/api/updates', async (req) => {
    const user = req.auth;
    const q = parse(
      z
        .object({
          q: z.string().max(200).optional(),
          system: z.string().uuid().optional(),
          release: z.string().max(100).optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          manage: z.enum(['0', '1']).default('0'),
        })
        .merge(pageQuery),
      req.query,
    );
    const manage = q.manage === '1' && !!user?.permissions.has('updates.manage');
    if (!manage && !anonymousAllowed(user)) return { total: 0, items: [], releases: [] };
    const values: unknown[] = [];
    const where: string[] = [];
    const add = (sql: string, v: unknown) => {
      values.push(v);
      where.push(sql.replaceAll('?', `$${values.length}`));
    };
    if (!manage) {
      where.push(`u.status = 'published'`);
      add('u.visibility = ANY(?::text[])', allowedVisibilities(user));
    }
    if (q.q) add(`u.search_vector @@ websearch_to_tsquery('pt_unaccent', ?)`, q.q);
    if (q.system) add('u.system_id = ?', q.system);
    if (q.release) add('u.release = ?', q.release);
    const range = dateRange(q.from, q.to);
    if (range.from) add('coalesce(u.completed_at, u.published_at) >= ?', range.from);
    if (range.to) add('coalesce(u.completed_at, u.published_at) <= ?', range.to);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await queryOne<{ n: string }>(`SELECT count(*) AS n FROM updates u ${whereSql}`, values);
    const rows = await query(
      `${SELECT} FROM updates u LEFT JOIN systems s ON s.id = u.system_id ${whereSql}
        ORDER BY coalesce(u.completed_at, u.published_at) DESC, u.jira_key DESC
        LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, q.pageSize, (q.page - 1) * q.pageSize],
    );
    // Releases disponíveis para filtro (respeitando a visibilidade do usuário).
    const releases = await query<{ release: string }>(
      `SELECT DISTINCT release FROM updates u ${manage ? '' : `WHERE u.status = 'published' AND u.visibility = ANY($1::text[])`} ORDER BY release DESC LIMIT 100`,
      manage ? [] : [allowedVisibilities(user)],
    );
    return { total: Number(total?.n ?? 0), items: rows.map((r) => serialize(r, manage, user?.userType === 'internal')), releases: releases.map((r) => r.release) };
  });

  app.get('/api/updates/integration', async (req) => {
    requirePermission(req, 'updates.manage');
    const c = config();
    return {
      webhookConfigured: !!c.JIRA_WEBHOOK_SECRET,
      apiConfigured: jiraConfigured(),
      baseUrl: c.JIRA_BASE_URL ?? null,
      releaseField: c.JIRA_RELEASE_FIELD,
      audienceField: c.JIRA_AUDIENCE_FIELD,
      projects: c.JIRA_PROJECT_KEYS ?? null,
      autoSyncMinutes: c.JIRA_SYNC_MINUTES,
      webhookPath: '/api/integrations/jira/webhook',
    };
  });

  app.get('/api/updates/:id', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const user = req.auth;
    const manage = !!user?.permissions.has('updates.manage');
    const r = await queryOne(`${SELECT} FROM updates u LEFT JOIN systems s ON s.id = u.system_id WHERE u.id = $1`, [id]);
    const visible =
      !!r && (manage || (r.status === 'published' && allowedVisibilities(user).includes(r.visibility as 'internal') && anonymousAllowed(user)));
    if (!r || !visible) throw notFound('Atualização não encontrada.');
    return { update: serialize(r, manage, user?.userType === 'internal') };
  });

  // -------------------------------------------------------------------------
  // Gestão (internos autorizados): conteúdo vem do Jira; aqui só se ajusta a exibição
  // -------------------------------------------------------------------------
  app.put('/api/updates/:id', async (req) => {
    const user = requirePermission(req, 'updates.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(
      z.object({ status: z.enum(['published', 'hidden']).optional(), visibility: z.enum(['internal', 'external']).optional(), systemId: z.string().uuid().nullable().optional() }),
      req.body,
    );
    const before = await queryOne(`SELECT status, visibility, system_id FROM updates WHERE id = $1`, [id]);
    if (!before) throw notFound('Atualização não encontrada.');
    await query(
      `UPDATE updates SET status = coalesce($2, status), visibility = coalesce($3, visibility),
              system_id = CASE WHEN $4::boolean THEN $5 ELSE system_id END, manual_override = true, updated_at = now() WHERE id = $1`,
      [id, body.status ?? null, body.visibility ?? null, body.systemId !== undefined, body.systemId ?? null],
    );
    await audit({ actorId: user.id, action: 'update.manual_change', entityType: 'update', entityId: id, data: { before, after: body }, ip: req.ip });
    const r = await queryOne(`${SELECT} FROM updates u LEFT JOIN systems s ON s.id = u.system_id WHERE u.id = $1`, [id]);
    return { update: serialize(r!, true) };
  });

  // Devolve ao Jira o controle da exibição.
  app.post('/api/updates/:id/release-control', async (req) => {
    const user = requirePermission(req, 'updates.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const row = await queryOne(`UPDATE updates SET manual_override = false, updated_at = now() WHERE id = $1 RETURNING id`, [id]);
    if (!row) throw notFound('Atualização não encontrada.');
    await audit({ actorId: user.id, action: 'update.override_removed', entityType: 'update', entityId: id, ip: req.ip });
    return { ok: true };
  });

  app.post('/api/updates/sync', async (req) => {
    const user = requirePermission(req, 'updates.manage');
    if (!jiraConfigured()) throw serviceUnavailable('JIRA_NOT_CONFIGURED', 'Configure JIRA_BASE_URL, JIRA_EMAIL e JIRA_API_TOKEN para sincronizar com o Jira.');
    try {
      const result = await syncFromJira();
      await audit({ actorId: user.id, action: 'update.sync', data: result, ip: req.ip });
      return result;
    } catch (err) {
      throw serviceUnavailable('JIRA_ERROR', `Falha ao consultar o Jira: ${(err as Error).message}`);
    }
  });
}
