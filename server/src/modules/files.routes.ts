import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { IMAGE_MIME_TYPES, VIDEO_MIME_TYPES, ATTACHMENT_MIME_TYPES } from '@shared/uploads.js';
import { type Db, getPool, queryOne, query } from '../db/pool.js';
import type { AuthUser } from '../auth/context.js';
import { requireInternal, hasPermission } from '../auth/context.js';
import {
  canSupportTicket,
  canViewAnnouncement,
  canViewArticle,
  canViewDocument,
  canViewSupportDocument,
  canViewTicket,
} from '../auth/policies.js';
import { audit } from '../lib/audit.js';
import { badRequest, forbidden, notFound, validationError } from '../lib/errors.js';
import { storage } from '../lib/storage.js';
import { discard, persistFile, publicFile, receiveFile, validateUpload, type ReceivedFile, type StoredFile } from '../lib/uploads.js';
import { parse, uuid } from '../lib/validate.js';

/** Regras de acesso a um arquivo: herdadas do recurso proprietário. */
export async function canAccessFile(user: AuthUser | null, file: StoredFile, db: Db = getPool()): Promise<boolean> {
  if (file.parent_file_id) {
    const parent = await queryOne<StoredFile>(`SELECT * FROM files WHERE id = $1 AND deleted_at IS NULL`, [file.parent_file_id], db);
    return !!parent && canAccessFile(user, parent, db);
  }
  if (!file.owner_type || !file.owner_id) {
    // Arquivo ainda não vinculado (upload em edição): somente quem enviou ou editores autorizados.
    if (!user || user.userType !== 'internal') return false;
    return file.uploaded_by === user.id || hasPermission(user, 'articles.edit_others') || hasPermission(user, 'announcements.manage');
  }
  switch (file.owner_type) {
    case 'article': {
      const a = await queryOne<{ status: string; visibility: string; author_id: string }>(
        `SELECT status, visibility, author_id FROM articles WHERE id = $1`,
        [file.owner_id],
        db,
      );
      return !!a && canViewArticle(user, a);
    }
    case 'announcement': {
      const a = await queryOne<{ status: string; visibility: string }>(`SELECT status, visibility FROM announcements WHERE id = $1`, [file.owner_id], db);
      return !!a && canViewAnnouncement(user, a);
    }
    case 'ticket': {
      const t = await queryOne<{ requester_id: string; company_id: string; assignee_id: string | null }>(
        `SELECT requester_id, company_id, assignee_id FROM tickets WHERE id = $1`,
        [file.owner_id],
        db,
      );
      return !!t && canViewTicket(user, t);
    }
    case 'ticket_note': {
      // Anexos de observações internas: somente a equipe de atendimento.
      const t = await queryOne<{ requester_id: string; company_id: string; assignee_id: string | null }>(
        `SELECT requester_id, company_id, assignee_id FROM tickets WHERE id = $1`,
        [file.owner_id],
        db,
      );
      return !!t && canSupportTicket(user, t);
    }
    case 'document': {
      const d = await queryOne<{ visibility: string; review_status: string; removed_at: Date | null }>(
        `SELECT visibility, review_status, removed_at FROM documents WHERE id = $1`,
        [file.owner_id],
        db,
      );
      return !!d && canViewDocument(user, d);
    }
    case 'support_document': {
      const d = await queryOne<{ visibility: string; deleted_at: Date | null }>(`SELECT visibility, deleted_at FROM support_documents WHERE id = $1`, [file.owner_id], db);
      return !!d && canViewSupportDocument(user, d);
    }
    default:
      return false;
  }
}

/** Indica se o arquivo é público (para definir a política de cache). */
async function isPublicFile(file: StoredFile): Promise<boolean> {
  return canAccessFile(null, file);
}

const INLINE_TYPES = new Set<string>([...IMAGE_MIME_TYPES, ...VIDEO_MIME_TYPES, 'application/pdf']);

async function sendFile(req: FastifyRequest, reply: FastifyReply, file: StoredFile, forceDownload: boolean) {
  const inline = !forceDownload && INLINE_TYPES.has(file.mime_type);
  const disposition = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.original_name)}`;
  const publicFile = await isPublicFile(file);
  reply.header('Cache-Control', publicFile ? 'private, max-age=60' : 'private, no-store');
  reply.header('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Cross-Origin-Resource-Policy', 'same-origin');

  const store = storage();
  if (store.signedUrl) {
    // Armazenamento de objetos: redireciona para URL temporária assinada (emitida após a autorização).
    const url = await store.signedUrl(file.storage_key, { filename: file.original_name, mimeType: file.mime_type, inline });
    reply.header('Cache-Control', 'private, no-store');
    return reply.redirect(url, 302);
  }

  const size = Number(file.size_bytes);
  reply.header('Content-Type', file.mime_type);
  reply.header('Content-Disposition', disposition);
  reply.header('Accept-Ranges', 'bytes');

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (m[1] === '' && m[2] === '')) {
      reply.header('Content-Range', `bytes */${size}`);
      return reply.code(416).send();
    }
    let start: number;
    let end: number;
    if (m[1] === '') {
      start = Math.max(0, size - Number(m[2]));
      end = size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    }
    if (start > end || start >= size) {
      reply.header('Content-Range', `bytes */${size}`);
      return reply.code(416).send();
    }
    reply.code(206);
    reply.header('Content-Range', `bytes ${start}-${end}/${size}`);
    reply.header('Content-Length', String(end - start + 1));
    return reply.send(await store.read(file.storage_key, { start, end }));
  }
  reply.header('Content-Length', String(size));
  return reply.send(await store.read(file.storage_key));
}

export default async function fileRoutes(app: FastifyInstance): Promise<void> {
  // Upload de mídia para o editor (artigos e comunicados). O arquivo fica "pendente"
  // e é vinculado ao recurso quando o conteúdo é salvo.
  app.post('/api/files', async (req) => {
    const user = requireInternal(req);
    const allowedToUpload = ['articles.create', 'articles.edit', 'articles.edit_others', 'announcements.manage'].some((p) =>
      user.permissions.has(p as never),
    );
    if (!allowedToUpload) throw forbidden();

    const part = await req.file();
    if (!part) throw badRequest('Nenhum arquivo enviado.');
    let received: ReceivedFile | null = null;
    try {
      received = await receiveFile(part);
      const mime = await validateUpload(received, ATTACHMENT_MIME_TYPES);
      const stored = await persistFile(received, { mime, uploadedBy: user.id });
      await audit({ actorId: user.id, action: 'file.upload', entityType: 'file', entityId: stored.id, data: { name: stored.original_name, mime, size: received.size }, ip: req.ip });
      return { file: publicFile(stored), warning: stored.thumbnailWarning ?? null };
    } finally {
      await discard(received);
    }
  });

  // Capa manual para vídeos enviados.
  app.post('/api/files/:id/cover', async (req) => {
    const user = requireInternal(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const video = await queryOne<StoredFile>(`SELECT * FROM files WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!video || !(await canAccessFile(user, video))) throw notFound();
    if (video.kind !== 'video') throw validationError('A capa só pode ser definida para vídeos.');
    const canEdit = video.uploaded_by === user.id || user.permissions.has('articles.edit_others') || user.permissions.has('announcements.manage');
    if (!canEdit) throw forbidden();

    const part = await req.file();
    if (!part) throw badRequest('Nenhuma imagem enviada.');
    let received: ReceivedFile | null = null;
    try {
      received = await receiveFile(part);
      const mime = await validateUpload(received, IMAGE_MIME_TYPES.filter((m) => m !== 'image/gif'));
      const cover = await persistFile(received, {
        mime,
        kind: 'thumbnail',
        uploadedBy: user.id,
        parentFileId: video.id,
        ownerType: video.owner_type,
        ownerId: video.owner_id,
        generateThumbnail: false,
      });
      await query(`UPDATE files SET thumbnail_id = $2 WHERE id = $1`, [video.id, cover.id]);
      return { file: publicFile({ ...video, thumbnail_id: cover.id }) };
    } finally {
      await discard(received);
    }
  });

  app.get('/api/files/:id/meta', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const file = await queryOne<StoredFile>(`SELECT * FROM files WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!file || !(await canAccessFile(req.auth, file))) throw notFound('Arquivo não encontrado.');
    return { file: publicFile(file) };
  });

  app.get('/api/files/:id', async (req, reply) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const q = parse(z.object({ variant: z.enum(['thumb', 'original']).optional(), download: z.enum(['0', '1']).optional() }), req.query);
    const file = await queryOne<StoredFile>(`SELECT * FROM files WHERE id = $1 AND deleted_at IS NULL`, [id]);
    // Nunca revela se o arquivo existe quando o usuário não tem acesso.
    if (!file || !(await canAccessFile(req.auth, file))) throw notFound('Arquivo não encontrado.');
    let target = file;
    if (q.variant === 'thumb' && file.thumbnail_id) {
      const thumb = await queryOne<StoredFile>(`SELECT * FROM files WHERE id = $1 AND deleted_at IS NULL`, [file.thumbnail_id]);
      if (thumb) target = thumb;
    }
    return sendFile(req, reply, target, q.download === '1');
  });
}
