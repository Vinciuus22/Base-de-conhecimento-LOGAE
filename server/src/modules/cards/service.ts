import { config } from '../../config.js';
import { query, queryOne } from '../../db/pool.js';
import { AppError, serviceUnavailable } from '../../lib/errors.js';
import { adfToText, jiraConfigured, jiraGet, JiraHttpError } from '../updates/jira.js';

/**
 * Atualizações dos Cards — espelho local SOMENTE LEITURA dos cards do Jira.
 * Nada aqui escreve no Jira. O histórico vem do changelog e dos comentários da API
 * (e do payload dos webhooks); nunca é reconstruído a partir do estado atual do card.
 */

export interface RawIssue {
  id?: string;
  key: string;
  self?: string;
  fields?: Record<string, unknown>;
}
interface RawHistory {
  id: string | number;
  author?: RawUser | null;
  created?: string;
  items?: Array<{ field?: string; fromString?: string | null; toString?: string | null; from?: string | null; to?: string | null }>;
}
interface RawUser {
  displayName?: string;
  emailAddress?: string;
  accountId?: string;
}
export interface RawComment {
  id: string | number;
  author?: RawUser | null;
  body?: unknown;
  created?: string;
  updated?: string;
  visibility?: unknown;
}

const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;

export const monitoredProjects = (): string[] =>
  config()
    .JIRA_CARD_PROJECTS.split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z][A-Z0-9_]*$/.test(s));

export const isMonitored = (cardKey: string): boolean => KEY_RE.test(cardKey) && monitoredProjects().includes(cardKey.split('-')[0]!);

export function isSharedAccount(name: string | null, accountId: string | null): boolean {
  const list = config()
    .JIRA_SHARED_ACCOUNTS.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) return false;
  return [name, accountId].some((v) => !!v && list.includes(v.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Retentativas e pausa (injetável nos testes)
// ---------------------------------------------------------------------------
let sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));
export function setSleep(fn: ((ms: number) => Promise<void>) | null): void {
  sleep = fn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
}

/** Retenta falhas temporárias (rede, 429, 5xx). Autenticação/permissão não são retentadas. */
async function jiraGetRetry(path: string, attempts = 4): Promise<unknown> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await jiraGet(path);
    } catch (err) {
      last = err;
      if (err instanceof JiraHttpError && err.status < 500 && err.status !== 429) throw err;
      if (i < attempts - 1) await sleep(Math.min(((err instanceof JiraHttpError && err.retryAfterSeconds) || 2 ** i) * 1000, 60_000));
    }
  }
  throw last;
}

export function describeJiraError(err: unknown): string {
  if (err instanceof JiraHttpError) {
    if (err.status === 401) return 'Falha de autenticação com o Jira (HTTP 401). Verifique JIRA_EMAIL e JIRA_API_TOKEN.';
    if (err.status === 403) return 'O usuário da integração não tem permissão no Jira (HTTP 403).';
    if (err.status === 404) return 'Recurso não encontrado ou inacessível no Jira (HTTP 404).';
    if (err.status === 429) return 'Limite de requisições do Jira atingido (HTTP 429).';
    return `O Jira respondeu HTTP ${err.status}.`;
  }
  return `Falha de conexão com o Jira: ${(err as Error).message ?? 'erro desconhecido'}`;
}

// ---------------------------------------------------------------------------
// Interpretação dos dados
// ---------------------------------------------------------------------------
const FIELD_LABELS: Record<string, string> = {
  status: 'Status',
  assignee: 'Responsável',
  description: 'Descrição',
  priority: 'Prioridade',
  summary: 'Título',
  reporter: 'Relator',
  labels: 'Etiquetas',
  duedate: 'Data de entrega',
  resolution: 'Resolução',
  Sprint: 'Sprint',
  'Fix Version': 'Versão de correção',
};
export const fieldLabel = (f: string): string => FIELD_LABELS[f] ?? f;

function eventTypeForField(field: string): string {
  switch (field.toLowerCase()) {
    case 'status':
      return 'status_change';
    case 'assignee':
      return 'assignee_change';
    case 'description':
      return 'description_change';
    case 'priority':
      return 'priority_change';
    default:
      return 'field_change';
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const named = (v: unknown, key = 'name'): string | null => (v && typeof v === 'object' ? str((v as Record<string, unknown>)[key]) : null);
const date = (v: unknown): Date | null => {
  const d = typeof v === 'string' ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};
const clip = (s: string | null, max = 20_000): string | null => (s && s.length > max ? `${s.slice(0, max)}…` : s);

function baseUrl(issue: RawIssue): string | null {
  const c = config().JIRA_BASE_URL;
  if (c) return c.replace(/\/+$/, '');
  try {
    return issue.self ? new URL(issue.self).origin : null;
  } catch {
    return null;
  }
}

export interface ParsedCard {
  jiraId: string;
  key: string;
  projectKey: string;
  projectName: string | null;
  title: string;
  description: string;
  status: string | null;
  statusCategory: string | null;
  priority: string | null;
  issueType: string | null;
  assigneeName: string | null;
  assigneeAccountId: string | null;
  reporterName: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  url: string | null;
}

export function parseCard(issue: RawIssue): ParsedCard {
  const f = issue.fields ?? {};
  const key = issue.key.toUpperCase();
  const base = baseUrl(issue);
  const assignee = f.assignee as RawUser | null | undefined;
  return {
    jiraId: String(issue.id ?? key),
    key,
    projectKey: named(f.project, 'key') ?? key.split('-')[0]!,
    projectName: named(f.project),
    title: str(f.summary) ?? key,
    description: clip(adfToText(f.description).trim()) ?? '',
    status: named(f.status),
    statusCategory: named(f.status && (f.status as Record<string, unknown>).statusCategory, 'key'),
    priority: named(f.priority),
    issueType: named(f.issuetype),
    assigneeName: assignee?.displayName ?? null,
    assigneeAccountId: assignee?.accountId ?? null,
    reporterName: named(f.reporter, 'displayName'),
    createdAt: date(f.created),
    updatedAt: date(f.updated),
    url: base ? `${base}/browse/${key}` : null,
  };
}

export interface ParsedEvent {
  eventKey: string;
  jiraEventId: string | null;
  type: string;
  field: string | null;
  from: string | null;
  to: string | null;
  comment: string | null;
  restricted: boolean;
  authorName: string | null;
  authorAccountId: string | null;
  at: Date;
  summary: string;
}

const display = (v: string | null): string => (v === null || v === '' ? '(vazio)' : v.length > 80 ? `${v.slice(0, 80)}…` : v);

export function parseHistory(h: RawHistory): ParsedEvent[] {
  const at = date(h.created);
  if (!at) return [];
  const seen = new Map<string, number>();
  const out: ParsedEvent[] = [];
  for (const item of h.items ?? []) {
    const field = item.field ?? 'campo';
    const n = (seen.get(field) ?? 0) + 1;
    seen.set(field, n);
    const from = item.fromString ?? item.from ?? null;
    const to = item.toString ?? item.to ?? null;
    const label = fieldLabel(field);
    const type = eventTypeForField(field);
    const summary =
      type === 'status_change'
        ? `Status alterado: ${display(from)} → ${display(to)}`
        : type === 'assignee_change'
          ? `Responsável alterado: ${from ?? 'Sem responsável'} → ${to ?? 'Sem responsável'}`
          : type === 'description_change'
            ? 'Descrição alterada'
            : `${label} alterado: ${display(from)} → ${display(to)}`;
    out.push({
      eventKey: `cl:${h.id}:${field}${n > 1 ? `#${n}` : ''}`,
      jiraEventId: String(h.id),
      type,
      field,
      from: clip(from),
      to: clip(to),
      comment: null,
      restricted: false,
      authorName: h.author?.displayName ?? null,
      authorAccountId: h.author?.accountId ?? null,
      at,
      summary,
    });
  }
  return out;
}

export function parseComment(c: RawComment): ParsedEvent[] {
  const at = date(c.created);
  if (!at) return [];
  const restricted = !!c.visibility; // comentário com restrição de grupo/função no Jira: conteúdo não é replicado
  const text = restricted ? null : clip(adfToText(c.body).trim());
  const author = { authorName: c.author?.displayName ?? null, authorAccountId: c.author?.accountId ?? null };
  const out: ParsedEvent[] = [
    { eventKey: `cm:${c.id}`, jiraEventId: String(c.id), type: 'comment', field: 'comment', from: null, to: null, comment: text, restricted, ...author, at, summary: 'Novo comentário', },
  ];
  const upd = date(c.updated);
  if (upd && upd.getTime() - at.getTime() > 1000) {
    out.push({ eventKey: `cm:${c.id}:u:${upd.getTime()}`, jiraEventId: String(c.id), type: 'comment_edited', field: 'comment', from: null, to: null, comment: text, restricted, ...author, at: upd, summary: 'Comentário editado' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Persistência
// ---------------------------------------------------------------------------
export async function upsertCard(issue: RawIssue, boardName?: string | null): Promise<{ id: string; created: boolean }> {
  const c = parseCard(issue);
  const row = await queryOne<{ id: string; inserted: boolean }>(
    `INSERT INTO jira_cards (jira_id, card_key, project_key, project_name, board_name, title, description, status, status_category, priority,
                             issue_type, assignee_name, assignee_account_id, reporter_name, jira_created_at, jira_updated_at, url, last_synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
     ON CONFLICT (card_key) DO UPDATE SET
       jira_id = EXCLUDED.jira_id, project_key = EXCLUDED.project_key,
       project_name = coalesce(EXCLUDED.project_name, jira_cards.project_name),
       board_name = coalesce(EXCLUDED.board_name, jira_cards.board_name),
       -- webhooks parciais não apagam o que já foi sincronizado
       title = EXCLUDED.title, description = CASE WHEN EXCLUDED.description <> '' OR $18::boolean THEN EXCLUDED.description ELSE jira_cards.description END,
       status = coalesce(EXCLUDED.status, jira_cards.status), status_category = coalesce(EXCLUDED.status_category, jira_cards.status_category),
       priority = coalesce(EXCLUDED.priority, jira_cards.priority), issue_type = coalesce(EXCLUDED.issue_type, jira_cards.issue_type),
       assignee_name = CASE WHEN $19::boolean THEN EXCLUDED.assignee_name ELSE jira_cards.assignee_name END,
       assignee_account_id = CASE WHEN $19::boolean THEN EXCLUDED.assignee_account_id ELSE jira_cards.assignee_account_id END,
       reporter_name = coalesce(EXCLUDED.reporter_name, jira_cards.reporter_name),
       jira_created_at = coalesce(EXCLUDED.jira_created_at, jira_cards.jira_created_at),
       jira_updated_at = greatest(EXCLUDED.jira_updated_at, jira_cards.jira_updated_at),
       url = coalesce(EXCLUDED.url, jira_cards.url), last_synced_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [
      c.jiraId, c.key, c.projectKey, c.projectName, boardName ?? null, c.title, c.description, c.status, c.statusCategory, c.priority, c.issueType,
      c.assigneeName, c.assigneeAccountId, c.reporterName, c.createdAt, c.updatedAt, c.url,
      issue.fields !== undefined && 'description' in issue.fields, // descrição presente no payload
      issue.fields !== undefined && 'assignee' in issue.fields, // responsável presente (inclusive null = sem responsável)
    ],
  );
  return { id: row!.id, created: row!.inserted };
}

export async function insertEvents(cardId: string, events: ParsedEvent[], source: string): Promise<number> {
  let added = 0;
  for (const e of events) {
    const r = await query(
      `INSERT INTO jira_card_events (card_id, event_key, jira_event_id, event_type, field_name, from_value, to_value, comment_text, comment_restricted,
                                     author_name, author_account_id, occurred_at, summary, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (card_id, event_key) DO NOTHING RETURNING id`,
      [cardId, e.eventKey, e.jiraEventId, e.type, e.field, e.from, e.to, e.comment, e.restricted, e.authorName, e.authorAccountId, e.at, e.summary, source],
    );
    added += r.length;
  }
  return added;
}

/** Evento sintético de criação (autor = relator informado pelo Jira). */
async function ensureCreatedEvent(cardId: string, issue: RawIssue): Promise<number> {
  const f = issue.fields ?? {};
  const at = date(f.created);
  if (!at) return 0;
  const reporter = f.reporter as RawUser | null | undefined;
  return insertEvents(
    cardId,
    [{ eventKey: 'created', jiraEventId: null, type: 'card_created', field: null, from: null, to: null, comment: null, restricted: false, authorName: reporter?.displayName ?? null, authorAccountId: reporter?.accountId ?? null, at, summary: 'Card criado' }],
    'sync',
  );
}

/** Atualiza o resumo da última alteração a partir do histórico persistido. */
export async function refreshLastEvent(cardId: string): Promise<void> {
  await query(
    `UPDATE jira_cards c SET last_event_type = e.event_type, last_event_author = e.author_name, last_event_at = e.occurred_at
       FROM (SELECT event_type, author_name, occurred_at FROM jira_card_events WHERE card_id = $1 ORDER BY occurred_at DESC, synced_at DESC LIMIT 1) e
      WHERE c.id = $1`,
    [cardId],
  );
}

// ---------------------------------------------------------------------------
// Recuperação completa do histórico de um card (changelog + comentários, paginados)
// ---------------------------------------------------------------------------
export async function syncIssueHistory(cardId: string, issue: RawIssue, source: string): Promise<{ added: number; complete: boolean; note: string | null }> {
  const key = encodeURIComponent(issue.key);
  let added = await ensureCreatedEvent(cardId, issue);
  let complete = true;
  let note: string | null = null;

  const paginate = async <T>(path: string, pick: (d: Record<string, unknown>) => T[], totalOf: (d: Record<string, unknown>) => number | undefined) => {
    const items: T[] = [];
    let startAt = 0;
    for (let page = 0; page < 200; page++) {
      const d = (await jiraGetRetry(`${path}${path.includes('?') ? '&' : '?'}startAt=${startAt}&maxResults=100`)) as Record<string, unknown>;
      const got = pick(d);
      items.push(...got);
      startAt += got.length;
      const total = totalOf(d);
      if (!got.length || d.isLast === true || (total !== undefined && startAt >= total)) return items;
    }
    throw new Error('Paginação excedeu o limite de segurança.');
  };

  try {
    const histories = await paginate<RawHistory>(`/rest/api/3/issue/${key}/changelog`, (d) => (d.values as RawHistory[]) ?? [], (d) => (typeof d.total === 'number' ? d.total : undefined));
    for (const h of histories) added += await insertEvents(cardId, parseHistory(h), source);
  } catch (err) {
    complete = false;
    note = `Histórico de campos incompleto: ${describeJiraError(err)}`;
  }
  try {
    const comments = await paginate<RawComment>(`/rest/api/3/issue/${key}/comment?orderBy=created`, (d) => (d.comments as RawComment[]) ?? [], (d) => (typeof d.total === 'number' ? d.total : undefined));
    for (const c of comments) added += await insertEvents(cardId, parseComment(c), source);
  } catch (err) {
    complete = false;
    note = `${note ? `${note} ` : ''}Comentários incompletos: ${describeJiraError(err)}`;
  }
  await query(`UPDATE jira_cards SET history_complete = $2, history_note = $3 WHERE id = $1`, [cardId, complete, note]);
  await refreshLastEvent(cardId);
  return { added, complete, note };
}

// ---------------------------------------------------------------------------
// Sincronização (completa / incremental)
// ---------------------------------------------------------------------------
const ISSUE_FIELDS = 'summary,description,status,assignee,reporter,priority,issuetype,project,created,updated';
let running = false;

export interface SyncResult {
  runId: string;
  kind: 'full' | 'incremental';
  status: 'success' | 'partial' | 'failed';
  cards: number;
  events: number;
  errors: string[];
}

async function boardNames(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const p of monitoredProjects()) {
    try {
      const d = (await jiraGetRetry(`/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(p)}&maxResults=20`, 2)) as { values?: Array<{ name?: string }> };
      const names = (d.values ?? []).map((b) => b.name).filter((n): n is string => !!n);
      if (names.length) out.set(p, names.slice(0, 3).join(', '));
    } catch {
      /* quadro é informação complementar; ausência de permissão no Agile não impede a sincronização */
    }
  }
  return out;
}

export async function lastSuccessfulRun(): Promise<{ started_at: Date; finished_at: Date | null } | null> {
  return queryOne(`SELECT started_at, finished_at FROM jira_sync_runs WHERE status = 'success' ORDER BY started_at DESC LIMIT 1`);
}

export async function syncCards(opts: { full?: boolean; triggeredBy?: string | null } = {}): Promise<SyncResult> {
  if (!jiraConfigured()) throw serviceUnavailable('JIRA_NOT_CONFIGURED', 'Configure JIRA_BASE_URL, JIRA_EMAIL e JIRA_API_TOKEN para sincronizar os cards.');
  const projects = monitoredProjects();
  if (!projects.length) throw serviceUnavailable('JIRA_NO_PROJECTS', 'Nenhum projeto configurado em JIRA_CARD_PROJECTS.');
  if (running) throw new AppError(409, 'SYNC_RUNNING', 'Já existe uma sincronização em andamento.');
  running = true;
  const last = opts.full ? null : await lastSuccessfulRun();
  const kind = last ? 'incremental' : 'full';
  const run = await queryOne<{ id: string }>(`INSERT INTO jira_sync_runs (kind, triggered_by) VALUES ($1, $2) RETURNING id`, [kind, opts.triggeredBy ?? null]);
  const result: SyncResult = { runId: run!.id, kind, status: 'success', cards: 0, events: 0, errors: [] };
  try {
    // JQL relativo evita problemas de fuso horário; sobreposição de 60 min (a ingestão é idempotente).
    const minutes = last ? Math.ceil((Date.now() - last.started_at.getTime()) / 60_000) + 60 : null;
    const jql = `project in (${projects.join(',')})${minutes ? ` AND updated >= -${minutes}m` : ''} ORDER BY updated ASC`;
    const boards = await boardNames();
    let token: string | undefined;
    for (let page = 0; page < 500; page++) {
      const params = new URLSearchParams({ jql, maxResults: '100', fields: ISSUE_FIELDS });
      if (token) params.set('nextPageToken', token);
      const data = (await jiraGetRetry(`/rest/api/3/search/jql?${params.toString()}`)) as { issues?: RawIssue[]; nextPageToken?: string; isLast?: boolean };
      for (const issue of data.issues ?? []) {
        if (!isMonitored(issue.key)) continue;
        result.cards++;
        try {
          const { id } = await upsertCard(issue, boards.get(issue.key.split('-')[0]!.toUpperCase()));
          const h = await syncIssueHistory(id, issue, 'sync');
          result.events += h.added;
          if (!h.complete) result.errors.push(`${issue.key}: ${h.note}`);
        } catch (err) {
          result.errors.push(`${issue.key}: ${describeJiraError(err)}`);
        }
      }
      token = data.nextPageToken;
      if (!token || data.isLast) break;
    }
    result.status = result.errors.length ? 'partial' : 'success';
  } catch (err) {
    // Falha geral: os dados já sincronizados são mantidos.
    result.status = 'failed';
    result.errors.push(describeJiraError(err));
  } finally {
    running = false;
    await query(`UPDATE jira_sync_runs SET finished_at = now(), status = $2, cards_seen = $3, events_added = $4, error = $5 WHERE id = $1`, [
      result.runId, result.status, result.cards, result.events, result.errors.length ? result.errors.slice(0, 20).join('\n').slice(0, 4000) : null,
    ]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------
export async function ingestWebhook(body: Record<string, unknown>): Promise<'processed' | 'duplicate' | 'ignored'> {
  const issue = body.issue as RawIssue | undefined;
  const event = typeof body.webhookEvent === 'string' ? body.webhookEvent : null;
  if (!issue || typeof issue.key !== 'string') throw new AppError(400, 'NO_ISSUE', 'Payload sem card do Jira.');
  const key = issue.key.toUpperCase();
  const changelog = body.changelog as RawHistory | undefined;
  const comment = body.comment as RawComment | undefined;
  const delivery = [event, issue.id ?? key, body.timestamp ?? '', changelog?.id ?? '', comment?.id ?? '', (comment as RawComment | undefined)?.updated ?? ''].join('|');

  const ins = await query(
    `INSERT INTO jira_webhook_events (delivery_key, webhook_event, card_key) VALUES ($1,$2,$3) ON CONFLICT (delivery_key) DO NOTHING RETURNING delivery_key`,
    [delivery, event, key],
  );
  if (!ins.length) {
    const prev = await queryOne<{ status: string }>(`SELECT status FROM jira_webhook_events WHERE delivery_key = $1`, [delivery]);
    if (prev?.status !== 'failed') return 'duplicate';
  }
  const finish = (status: string, error?: string) =>
    query(`UPDATE jira_webhook_events SET status = $2, error = $3 WHERE delivery_key = $1`, [delivery, status, error ?? null]);

  if (!isMonitored(key)) {
    await finish('ignored');
    return 'ignored';
  }
  try {
    const { id } = await upsertCard(issue);
    const events: ParsedEvent[] = [];
    if (changelog) events.push(...parseHistory(changelog));
    if (comment && event !== 'comment_deleted') events.push(...parseComment(comment));
    if (comment && event === 'comment_deleted') {
      events.push({
        eventKey: `cmdel:${comment.id}:${body.timestamp ?? ''}`, jiraEventId: String(comment.id), type: 'comment_deleted', field: 'comment', from: null, to: null, comment: null, restricted: false,
        authorName: comment.author?.displayName ?? null, authorAccountId: comment.author?.accountId ?? null, at: new Date(typeof body.timestamp === 'number' ? body.timestamp : Date.now()), summary: 'Comentário removido',
      });
    }
    await insertEvents(id, events, 'webhook');
    await ensureCreatedEvent(id, issue);
    if (event === 'jira:issue_deleted') {
      await query(`UPDATE jira_cards SET history_note = $2 WHERE id = $1`, [id, `Card removido no Jira em ${new Date().toISOString()}. Dados locais preservados.`]);
    } else if (jiraConfigured()) {
      // Reconciliação: complementa o webhook com o histórico completo (falha aqui não perde o que o webhook trouxe).
      try {
        await syncIssueHistory(id, issue, 'webhook');
      } catch {
        /* mantém o que o payload trouxe */
      }
    } else {
      await query(`UPDATE jira_cards SET history_complete = false, history_note = 'Histórico montado apenas com os webhooks recebidos; configure a API do Jira para recuperar o histórico completo.' WHERE id = $1 AND history_note IS NULL`, [id]);
    }
    await refreshLastEvent(id);
    await finish('processed');
    return 'processed';
  } catch (err) {
    await finish('failed', (err as Error).message.slice(0, 500));
    throw err;
  }
}
