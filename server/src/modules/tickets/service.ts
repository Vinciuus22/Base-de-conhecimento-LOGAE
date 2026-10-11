import type pg from 'pg';
import {
  TICKET_STATUS_LABELS,
  SUPPORT_STATUS_TRANSITIONS,
  type TicketStatus,
} from '@shared/domain.js';
import { IMAGE_MIME_TYPES, VIDEO_MIME_TYPES, ATTACHMENT_MIME_TYPES } from '@shared/uploads.js';
import { type Db, getPool, query, queryOne } from '../../db/pool.js';
import type { AuthUser } from '../../auth/context.js';
import { allowedVisibilities } from '../../auth/context.js';
import { canSupportTicket, canViewTicket, canViewTicketAsCustomer } from '../../auth/policies.js';
import { audit } from '../../lib/audit.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { persistFile, publicFile, validateUpload, type ReceivedFile, type StoredFile } from '../../lib/uploads.js';

export interface TicketRow {
  id: string;
  protocol: string;
  title: string;
  description: string;
  request_type: string;
  category_id: string | null;
  priority: string;
  status: TicketStatus;
  system_id: string;
  company_id: string;
  requester_id: string;
  assignee_id: string | null;
  analysis_result: string | null;
  procedures: string | null;
  solution: string | null;
  guidance: string | null;
  created_at: Date;
  updated_at: Date;
  resolved_at: Date | null;
  closed_at: Date | null;
}

export const MEDIA_TYPES = [...IMAGE_MIME_TYPES, ...VIDEO_MIME_TYPES] as readonly string[];

export async function loadTicket(id: string, db: Db = getPool(), forUpdate = false): Promise<TicketRow | null> {
  return queryOne<TicketRow>(`SELECT * FROM tickets WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [id], db);
}

/** Carrega o ticket e verifica a autorização; nunca revela tickets de terceiros (404). */
export async function loadTicketForViewer(user: AuthUser, id: string, ip?: string): Promise<TicketRow> {
  const t = await loadTicket(id);
  if (!t || !canViewTicket(user, t)) {
    if (t) {
      await audit({ actorId: user.id, action: 'ticket.access_denied', entityType: 'ticket', entityId: id, ip });
    }
    throw notFound('Ticket não encontrado.');
  }
  return t;
}

export function assertSupport(user: AuthUser, t: TicketRow): void {
  if (!canSupportTicket(user, t)) {
    if (!canViewTicket(user, t)) throw notFound('Ticket não encontrado.');
    throw forbidden('Você não está autorizado a atender este ticket.');
  }
}

export async function nextProtocol(db: Db): Promise<string> {
  const row = await queryOne<{ seq: string; year: string }>(
    `SELECT nextval('ticket_protocol_seq')::text AS seq, to_char(now() AT TIME ZONE 'UTC', 'YYYY') AS year`,
    [],
    db,
  );
  return `${row!.year}${row!.seq.padStart(6, '0')}`;
}

export async function addEvent(
  db: Db,
  ticketId: string,
  actorId: string | null,
  type: string,
  opts: { from?: string | null; to?: string | null; data?: Record<string, unknown>; isPublic?: boolean } = {},
): Promise<void> {
  await db.query(
    `INSERT INTO ticket_events (ticket_id, actor_id, type, from_status, to_status, data, public) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [ticketId, actorId, type, opts.from ?? null, opts.to ?? null, JSON.stringify(opts.data ?? {}), opts.isPublic ?? true],
  );
}

/** Altera o status registrando data, hora e responsável. */
export async function setStatus(
  db: pg.PoolClient,
  ticket: TicketRow,
  to: TicketStatus,
  actorId: string | null,
  data: Record<string, unknown> = {},
): Promise<void> {
  if (ticket.status === to) return;
  await db.query(
    `UPDATE tickets SET status = $2, updated_at = now(),
            resolved_at = CASE WHEN $2 = 'resolved' THEN now() WHEN $2 IN ('closed') THEN resolved_at ELSE NULL END,
            closed_at = CASE WHEN $2 = 'closed' THEN now() ELSE NULL END
      WHERE id = $1`,
    [ticket.id, to],
  );
  await addEvent(db, ticket.id, actorId, 'status_change', { from: ticket.status, to, data });
  ticket.status = to;
}

export function canSupportTransition(from: TicketStatus, to: TicketStatus): boolean {
  return SUPPORT_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

export async function attachFiles(
  db: pg.PoolClient,
  ticketId: string,
  files: ReceivedFile[],
  uploaderId: string,
  opts: { messageId?: string | null; noteId?: string | null; mediaOnly?: boolean },
): Promise<StoredFile[]> {
  const stored: StoredFile[] = [];
  for (const f of files) {
    const mime = await validateUpload(f, opts.mediaOnly ? MEDIA_TYPES : ATTACHMENT_MIME_TYPES);
    const s = await persistFile(f, { mime, ownerType: opts.noteId ? 'ticket_note' : 'ticket', ownerId: ticketId, uploadedBy: uploaderId }, db);
    await db.query(`INSERT INTO ticket_attachments (ticket_id, file_id, message_id, note_id) VALUES ($1, $2, $3, $4)`, [
      ticketId,
      s.id,
      opts.messageId ?? null,
      opts.noteId ?? null,
    ]);
    stored.push(s);
  }
  return stored;
}

/** Validação prévia dos arquivos (antes de abrir a transação), para mensagens claras. */
export async function prevalidateFiles(files: ReceivedFile[], allowed: readonly string[]): Promise<void> {
  for (const f of files) await validateUpload(f, allowed);
}

// ---------------------------------------------------------------------------
// Serialização
// ---------------------------------------------------------------------------
export async function serializeTicketSummary(rows: Array<Record<string, unknown>>) {
  return rows.map((r) => ({
    id: r.id,
    protocol: r.protocol,
    title: r.title,
    status: r.status,
    statusLabel: TICKET_STATUS_LABELS[r.status as TicketStatus],
    priority: r.priority,
    requestType: r.request_type,
    system: r.system_name,
    company: r.company_name,
    requester: r.requester_name,
    assignee: r.assignee_name ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

/**
 * Detalhe do ticket. No modo "customer", observações internas, eventos internos e
 * anexos de observações NUNCA são carregados (consultas separadas por tabela).
 */
export async function serializeTicketDetail(user: AuthUser, t: TicketRow, mode: 'customer' | 'support') {
  const base = await queryOne<{ system_name: string; company_name: string; requester_name: string; requester_email: string; assignee_name: string | null; category_name: string | null }>(
    `SELECT s.name AS system_name, c.name AS company_name, r.name AS requester_name, r.email AS requester_email,
            a.name AS assignee_name, cat.name AS category_name
       FROM tickets t
       JOIN systems s ON s.id = t.system_id
       JOIN companies c ON c.id = t.company_id
       JOIN users r ON r.id = t.requester_id
       LEFT JOIN users a ON a.id = t.assignee_id
       LEFT JOIN categories cat ON cat.id = t.category_id
      WHERE t.id = $1`,
    [t.id],
  );

  const messages = await query<{ id: string; kind: string; body: string; created_at: Date; author_id: string; author_name: string; author_type: string }>(
    `SELECT m.id, m.kind, m.body, m.created_at, u.id AS author_id, u.name AS author_name, u.user_type AS author_type
       FROM ticket_messages m JOIN users u ON u.id = m.author_id
      WHERE m.ticket_id = $1 ORDER BY m.created_at, m.id`,
    [t.id],
  );
  const events = await query<{ id: string; type: string; from_status: string | null; to_status: string | null; data: Record<string, unknown>; created_at: Date; actor_name: string | null; public: boolean }>(
    `SELECT e.id, e.type, e.from_status, e.to_status, e.data, e.created_at, u.name AS actor_name, e.public
       FROM ticket_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.ticket_id = $1 ${mode === 'customer' ? 'AND e.public = true' : ''}
      ORDER BY e.created_at, e.id`,
    [t.id],
  );
  const attachments = await query<StoredFile & { message_id: string | null; note_id: string | null }>(
    `SELECT f.*, ta.message_id, ta.note_id
       FROM ticket_attachments ta JOIN files f ON f.id = ta.file_id
      WHERE ta.ticket_id = $1 AND f.deleted_at IS NULL ${mode === 'customer' ? 'AND ta.note_id IS NULL' : ''}
      ORDER BY ta.created_at`,
    [t.id],
  );
  const vis = allowedVisibilities(user);
  const articles = await query<{ id: string; slug: string; title: string }>(
    `SELECT a.id, a.slug, a.title FROM ticket_articles ta JOIN articles a ON a.id = ta.article_id
      WHERE ta.ticket_id = $1 ${mode === 'customer' ? `AND a.status = 'published' AND a.visibility = ANY($2::text[])` : ''}
      ORDER BY ta.created_at`,
    mode === 'customer' ? [t.id, vis] : [t.id],
  );

  const filesFor = (pred: (a: (typeof attachments)[number]) => boolean) => attachments.filter(pred).map((a) => publicFile(a));
  const timeline: Array<Record<string, unknown>> = [
    {
      type: 'opened',
      id: `opened-${t.id}`,
      createdAt: t.created_at,
      author: { name: base?.requester_name, role: 'requester' },
      body: t.description,
      files: filesFor((a) => !a.message_id && !a.note_id),
    },
    ...messages.map((m) => ({
      type: 'message',
      id: m.id,
      kind: m.kind,
      createdAt: m.created_at,
      author: { name: m.author_name, role: m.author_id === t.requester_id ? 'requester' : m.author_type === 'internal' ? 'support' : 'customer' },
      body: m.body,
      files: filesFor((a) => a.message_id === m.id),
    })),
    ...events.map((e) => ({
        type: 'event',
        id: `ev-${e.id}`,
        eventType: e.type,
        createdAt: e.created_at,
        author: { name: e.actor_name ?? 'Sistema' },
        from: e.from_status,
        to: e.to_status,
        data: e.data,
        internal: !e.public,
      })),
  ];

  if (mode === 'support') {
    const notes = await query<{ id: string; body: string; created_at: Date; author_name: string }>(
      `SELECT n.id, n.body, n.created_at, u.name AS author_name FROM ticket_internal_notes n JOIN users u ON u.id = n.author_id
        WHERE n.ticket_id = $1 ORDER BY n.created_at`,
      [t.id],
    );
    timeline.push(
      ...notes.map((n) => ({
        type: 'internal_note',
        id: n.id,
        createdAt: n.created_at,
        author: { name: n.author_name, role: 'support' },
        body: n.body,
        files: filesFor((a) => a.note_id === n.id),
        internal: true,
      })),
    );
  }
  timeline.sort((a, b) => new Date(a.createdAt as Date).getTime() - new Date(b.createdAt as Date).getTime());

  return {
    id: t.id,
    protocol: t.protocol,
    title: t.title,
    description: t.description,
    requestType: t.request_type,
    category: t.category_id ? { id: t.category_id, name: base?.category_name } : null,
    priority: t.priority,
    status: t.status,
    statusLabel: TICKET_STATUS_LABELS[t.status],
    system: { id: t.system_id, name: base?.system_name },
    company: { id: t.company_id, name: base?.company_name },
    requester: { id: t.requester_id, name: base?.requester_name, ...(mode === 'support' ? { email: base?.requester_email } : {}) },
    assignee: t.assignee_id ? { id: t.assignee_id, name: base?.assignee_name } : null,
    analysisResult: t.analysis_result,
    procedures: t.procedures,
    solution: t.solution,
    guidance: t.guidance,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    resolvedAt: t.resolved_at,
    closedAt: t.closed_at,
    relatedArticles: articles,
    timeline,
    mode,
    permissions: {
      canSupport: canSupportTicket(user, t),
      isCustomer: canViewTicketAsCustomer(user, t),
    },
  };
}
