import { config } from '../../config.js';
import { audit } from '../../lib/audit.js';
import { query, queryOne } from '../../db/pool.js';
import { normalize, truncate } from '../../lib/text.js';

/**
 * Integração com o Jira.
 *
 * Regra: quando uma tarefa é CONCLUÍDA e o campo "release" está preenchido, ela
 * vira uma atualização publicada. O campo "Público alvo" define quem vê:
 *   externo / cliente → visível a clientes e internos
 *   ambos / todos     → visível a clientes e internos
 *   interno           → somente usuários internos
 * Valor ausente ou desconhecido → interno (padrão seguro, nunca expõe sem querer).
 */

export interface JiraIssue {
  key: string;
  fields: Record<string, unknown>;
  names?: Record<string, string>;
}

export interface ParsedUpdate {
  jiraKey: string;
  jiraUrl: string | null;
  title: string;
  description: string;
  release: string | null;
  audienceRaw: string | null;
  visibility: 'internal' | 'external';
  jiraStatus: string | null;
  done: boolean;
  completedAt: Date | null;
  componentName: string | null;
}

/** Converte qualquer valor de campo do Jira em lista de textos. */
export function fieldValues(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(fieldValues);
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const k of ['value', 'name', 'displayName', 'label']) {
      if (typeof o[k] === 'string' && (o[k] as string).trim()) {
        const child = o.child ? fieldValues(o.child) : [];
        return [(o[k] as string).trim(), ...child];
      }
    }
  }
  return [];
}

/** Texto simples a partir do Atlassian Document Format (ou string). */
export function adfToText(node: unknown): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  const n = node as { type?: string; text?: string; content?: unknown[]; attrs?: { text?: string } };
  if (n.type === 'text') return n.text ?? '';
  if (n.type === 'hardBreak') return '\n';
  if (n.type === 'mention' || n.type === 'emoji') return n.attrs?.text ?? '';
  const inner = (n.content ?? []).map(adfToText);
  switch (n.type) {
    case 'paragraph':
    case 'heading':
    case 'codeBlock':
    case 'blockquote':
      return `${inner.join('')}\n\n`;
    case 'listItem':
      return `• ${inner.join('').trim()}\n`;
    case 'bulletList':
    case 'orderedList':
      return `${inner.join('')}\n`;
    default:
      return inner.join('');
  }
}

/** Interpreta o "Público alvo". */
export function parseAudience(values: string[]): 'internal' | 'external' {
  if (!values.length) return 'internal';
  let external = false;
  for (const v of values) {
    const t = normalize(v);
    if (/(ambos|todos|both|all|public)/.test(t) || /(extern|client|usuario final)/.test(t)) external = true;
  }
  return external ? 'external' : 'internal';
}

/** Descobre a chave do campo no payload: por id, por nome (via `names`) ou pelo próprio nome. */
export function resolveFieldKey(configured: string, fields: Record<string, unknown>, names?: Record<string, string>): string | null {
  if (configured in fields) return configured;
  if (names) {
    const wanted = normalize(configured);
    for (const [key, label] of Object.entries(names)) if (normalize(label) === wanted && key in fields) return key;
    for (const [key, label] of Object.entries(names)) if (normalize(label) === wanted) return key;
  }
  return null;
}

export function isDone(fields: Record<string, unknown>): boolean {
  const status = fields.status as { name?: string; statusCategory?: { key?: string } } | undefined;
  if (status?.statusCategory?.key === 'done') return true;
  const doneNames = config().JIRA_DONE_STATUSES.split(',').map((s) => normalize(s.trim()));
  return !!status?.name && doneNames.includes(normalize(status.name));
}

export function parseIssue(issue: JiraIssue): ParsedUpdate {
  const cfg = config();
  const f = issue.fields ?? {};
  const releaseKey = resolveFieldKey(cfg.JIRA_RELEASE_FIELD, f, issue.names);
  const audienceKey = resolveFieldKey(cfg.JIRA_AUDIENCE_FIELD, f, issue.names);
  const releaseValues = releaseKey ? fieldValues(f[releaseKey]) : [];
  const audienceValues = audienceKey ? fieldValues(f[audienceKey]) : [];
  const status = f.status as { name?: string } | undefined;
  const components = fieldValues(f.components);
  const resolved = (f.resolutiondate ?? f.statuscategorychangedate ?? f.updated) as string | undefined;
  const base = cfg.JIRA_BASE_URL?.replace(/\/+$/, '');
  const description = adfToText(f.description).replace(/\n{3,}/g, '\n\n').trim();
  return {
    jiraKey: issue.key,
    jiraUrl: base ? `${base}/browse/${issue.key}` : null,
    title: truncate(String(f.summary ?? issue.key).trim() || issue.key, 300),
    description,
    release: releaseValues.length ? releaseValues.join(', ') : null,
    audienceRaw: audienceValues.length ? audienceValues.join(', ') : null,
    visibility: parseAudience(audienceValues),
    jiraStatus: status?.name ?? null,
    done: isDone(f),
    completedAt: resolved && !Number.isNaN(Date.parse(resolved)) ? new Date(resolved) : null,
    componentName: components[0] ?? null,
  };
}

export type ProcessResult = 'published' | 'updated' | 'hidden' | 'ignored';

/**
 * Aplica a regra de negócio a uma tarefa do Jira:
 *  - concluída + release preenchido → cria/atualiza e PUBLICA;
 *  - já existia e deixou de cumprir a regra (reaberta, release removido) → OCULTA;
 *  - não cumpre a regra e não existia → ignora.
 * Ajustes manuais (manual_override) de público e situação não são sobrescritos.
 */
export async function processIssue(issue: JiraIssue, source: 'webhook' | 'sync'): Promise<ProcessResult> {
  const p = parseIssue(issue);
  const existing = await queryOne<{ id: string; manual_override: boolean; status: string }>(
    `SELECT id, manual_override, status FROM updates WHERE jira_key = $1`,
    [p.jiraKey],
  );
  const qualifies = p.done && !!p.release;

  if (!qualifies) {
    if (existing && existing.status === 'published' && !existing.manual_override) {
      await query(`UPDATE updates SET status = 'hidden', jira_status = $2, updated_at = now() WHERE id = $1`, [existing.id, p.jiraStatus]);
      await audit({ actorId: null, action: 'update.hidden_by_jira', entityType: 'update', entityId: existing.id, data: { jiraKey: p.jiraKey, status: p.jiraStatus, source } });
      return 'hidden';
    }
    return 'ignored';
  }

  const system = p.componentName
    ? await queryOne<{ id: string }>(`SELECT id FROM systems WHERE lower(immutable_unaccent(name)) = lower(immutable_unaccent($1))`, [p.componentName])
    : null;

  if (existing) {
    await query(
      `UPDATE updates SET jira_url = $2, title = $3, description_text = $4, release = $5, audience_raw = $6,
              visibility = CASE WHEN manual_override THEN visibility ELSE $7 END,
              status = CASE WHEN manual_override THEN status ELSE 'published' END,
              system_id = coalesce($8, system_id), jira_status = $9, completed_at = $10, updated_at = now()
        WHERE id = $1`,
      [existing.id, p.jiraUrl, p.title, p.description, p.release, p.audienceRaw, p.visibility, system?.id ?? null, p.jiraStatus, p.completedAt],
    );
    await audit({ actorId: null, action: 'update.updated_from_jira', entityType: 'update', entityId: existing.id, data: { jiraKey: p.jiraKey, release: p.release, source } });
    return 'updated';
  }
  const row = await queryOne<{ id: string }>(
    `INSERT INTO updates (jira_key, jira_url, title, description_text, release, audience_raw, visibility, system_id, jira_status, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [p.jiraKey, p.jiraUrl, p.title, p.description, p.release, p.audienceRaw, p.visibility, system?.id ?? null, p.jiraStatus, p.completedAt],
  );
  await audit({ actorId: null, action: 'update.published_from_jira', entityType: 'update', entityId: row!.id, data: { jiraKey: p.jiraKey, release: p.release, visibility: p.visibility, source } });
  return 'published';
}

// ---------------------------------------------------------------------------
// API REST do Jira Cloud (sincronização)
// ---------------------------------------------------------------------------
export function jiraConfigured(): boolean {
  const c = config();
  return !!(c.JIRA_BASE_URL && c.JIRA_EMAIL && c.JIRA_API_TOKEN);
}

export type JiraFetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; headers?: { get(name: string): string | null } }>;

export class JiraHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(`Jira respondeu HTTP ${status}`);
  }
}
let fetchOverride: JiraFetch | null = null;
export function setJiraFetch(fn: JiraFetch | null): void {
  fetchOverride = fn;
}

export async function jiraGet(path: string): Promise<unknown> {
  const c = config();
  const url = `${c.JIRA_BASE_URL!.replace(/\/+$/, '')}${path}`;
  const headers = {
    Accept: 'application/json',
    Authorization: `Basic ${Buffer.from(`${c.JIRA_EMAIL}:${c.JIRA_API_TOKEN}`).toString('base64')}`,
  };
  const res = await (fetchOverride ?? ((u, i) => fetch(u, { ...i, signal: AbortSignal.timeout(30_000) })))(url, { headers });
  if (!res.ok) {
    const ra = Number(res.headers?.get('retry-after'));
    throw new JiraHttpError(res.status, Number.isFinite(ra) && ra > 0 ? ra : undefined);
  }
  return res.json();
}

/** Monta a cláusula JQL do campo release. */
export function releaseJql(field: string): string {
  if (field === 'fixVersions' || field === 'fixVersion') return 'fixVersion is not EMPTY';
  const m = /^customfield_(\d+)$/.exec(field);
  if (m) return `cf[${m[1]}] is not EMPTY`;
  return `"${field.replace(/"/g, '')}" is not EMPTY`;
}

export async function syncFromJira(sinceMinutes?: number): Promise<{ found: number; published: number; updated: number; hidden: number; ignored: number }> {
  const c = config();
  const clauses = ['statusCategory = Done', releaseJql(c.JIRA_RELEASE_FIELD)];
  const projects = (c.JIRA_PROJECT_KEYS ?? '').split(',').map((s) => s.trim()).filter((s) => /^[A-Z][A-Z0-9_]*$/i.test(s));
  if (projects.length) clauses.push(`project in (${projects.join(',')})`);
  if (sinceMinutes && sinceMinutes > 0) clauses.push(`updated >= -${Math.ceil(sinceMinutes)}m`);
  const jql = `${clauses.join(' AND ')} ORDER BY updated DESC`;

  const totals = { found: 0, published: 0, updated: 0, hidden: 0, ignored: 0 };
  let nextToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({ jql, maxResults: '100', fields: '*all', expand: 'names' });
    if (nextToken) params.set('nextPageToken', nextToken);
    const data = (await jiraGet(`/rest/api/3/search/jql?${params.toString()}`)) as {
      issues?: JiraIssue[];
      names?: Record<string, string>;
      nextPageToken?: string;
      isLast?: boolean;
    };
    for (const issue of data.issues ?? []) {
      totals.found++;
      const r = await processIssue({ ...issue, names: data.names ?? issue.names }, 'sync');
      totals[r === 'published' ? 'published' : r === 'updated' ? 'updated' : r === 'hidden' ? 'hidden' : 'ignored']++;
    }
    nextToken = data.nextPageToken;
    if (!nextToken || data.isLast) break;
  }
  return totals;
}

/** Busca uma tarefa com os nomes dos campos (usado quando o webhook não traz `names`). */
export async function fetchIssueWithNames(key: string): Promise<JiraIssue | null> {
  if (!jiraConfigured() || !/^[A-Z][A-Z0-9_]*-\d+$/i.test(key)) return null;
  try {
    return (await jiraGet(`/rest/api/3/issue/${encodeURIComponent(key)}?expand=names`)) as JiraIssue;
  } catch {
    return null;
  }
}
