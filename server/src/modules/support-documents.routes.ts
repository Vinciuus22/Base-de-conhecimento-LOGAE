import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SUPPORT_DOCUMENT_MIME_TYPES } from '@shared/uploads.js';
import { config } from '../config.js';
import { query, queryOne, withTransaction } from '../db/pool.js';
import { requirePermission } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound, validationError } from '../lib/errors.js';
import { readMultipart } from '../lib/multipart.js';
import { persistFile, validateUpload } from '../lib/uploads.js';
import { parse, uuid } from '../lib/validate.js';

/**
 * Documentos de apoio do suporte: requisições, documentação de API, manuais e planilhas.
 * Cada item tem um arquivo anexado OU um link externo. Acesso restrito a quem gerencia documentos.
 */
export const SUPPORT_DOC_TYPES = ['requisicao', 'api', 'pdf', 'planilha', 'outro'] as const;

const metaSchema = z.object({
  title: z.string().trim().min(1, 'Informe o título.').max(200),
  type: z.enum(SUPPORT_DOC_TYPES, { errorMap: () => ({ message: 'Selecione o tipo.' }) }),
  systemId: z.string().uuid('Selecione o sistema.'),
  visibility: z.enum(['internal', 'external'], { errorMap: () => ({ message: 'Selecione a visibilidade.' }) }),
  description: z.string().trim().max(2000).optional().transform((v) => v || null),
  externalUrl: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((v) => v || null)
    .refine((v) => v === null || /^https?:\/\/[^\s]+$/i.test(v), 'Informe um link válido (http:// ou https://).'),
});

const like = (v: string) => `%${v.replace(/[\\%_]/g, '\\$&')}%`;

const SELECT = `
  SELECT d.id, d.title, d.doc_type, d.system_id, s.name AS system_name, d.visibility, d.description, d.external_url, d.created_at,
         u.name AS author_name, f.id AS file_id, f.original_name, f.size_bytes
    FROM support_documents d
    JOIN systems s ON s.id = d.system_id
    JOIN users u ON u.id = d.author_id
    LEFT JOIN files f ON f.id = d.file_id`;

function serialize(r: Record<string, unknown>) {
  return {
    id: r.id,
    title: r.title,
    type: r.doc_type,
    system: { id: r.system_id, name: r.system_name },
    visibility: r.visibility,
    description: r.description,
    author: r.author_name,
    createdAt: r.created_at,
    externalUrl: r.external_url,
    file: r.file_id ? { id: r.file_id, name: r.original_name, size: Number(r.size_bytes), url: `/api/files/${r.file_id}?download=1` } : null,
  };
}

export default async function supportDocumentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/support-documents', async (req) => {
    requirePermission(req, 'documents.manage');
    const q = parse(z.object({ q: z.string().max(200).optional(), type: z.enum(SUPPORT_DOC_TYPES).optional(), system: z.string().uuid().optional() }), req.query);
    const values: unknown[] = [];
    const where = ['d.deleted_at IS NULL'];
    if (q.q) {
      values.push(like(q.q));
      where.push(`(unaccent(d.title) ILIKE unaccent($${values.length}) OR unaccent(coalesce(d.description, '')) ILIKE unaccent($${values.length}) OR unaccent(coalesce(f.original_name, '')) ILIKE unaccent($${values.length}))`);
    }
    if (q.type) {
      values.push(q.type);
      where.push(`d.doc_type = $${values.length}`);
    }
    if (q.system) {
      values.push(q.system);
      where.push(`d.system_id = $${values.length}`);
    }
    const rows = await query(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC LIMIT 300`, values);
    return { items: rows.map(serialize) };
  });

  app.post('/api/support-documents', async (req, reply) => {
    const user = requirePermission(req, 'documents.manage');
    const form = await readMultipart(req, { maxFiles: 1 });
    try {
      const file = form.files[0];
      const meta = parse(metaSchema, form.fields);
      if (!file && !meta.externalUrl) throw validationError('Anexe um arquivo ou informe um link externo.', { fields: { file: 'Anexe um arquivo ou informe um link externo.' } });
      const sys = await queryOne(`SELECT 1 FROM systems WHERE id = $1`, [meta.systemId]);
      if (!sys) throw badRequest('Sistema inválido.');
      const mime = file ? await validateUpload(file, SUPPORT_DOCUMENT_MIME_TYPES, config().MAX_DOCUMENT_MB * 1024 * 1024) : null;
      const id = await withTransaction(async (client) => {
        const docId = randomUUID();
        let fileId: string | null = null;
        if (file && mime) {
          fileId = (await persistFile(file, { mime, kind: 'attachment', ownerType: 'support_document', ownerId: docId, uploadedBy: user.id, generateThumbnail: false }, client)).id;
        }
        await client.query(
          `INSERT INTO support_documents (id, title, doc_type, system_id, visibility, description, external_url, file_id, author_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [docId, meta.title, meta.type, meta.systemId, meta.visibility, meta.description, meta.externalUrl, fileId, user.id],
        );
        await audit({ actorId: user.id, action: 'document.support_create', entityType: 'support_document', entityId: docId, data: { title: meta.title, type: meta.type, visibility: meta.visibility, hasFile: !!file, externalUrl: meta.externalUrl }, ip: req.ip }, client);
        return docId;
      });
      reply.code(201);
      const row = await queryOne(`${SELECT} WHERE d.id = $1`, [id]);
      return { document: serialize(row!) };
    } finally {
      await form.cleanup();
    }
  });

  app.delete('/api/support-documents/:id', async (req) => {
    const user = requirePermission(req, 'documents.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const row = await queryOne<{ title: string }>(`UPDATE support_documents SET deleted_at = now(), deleted_by = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING title`, [id, user.id]);
    if (!row) throw notFound('Documento não encontrado.');
    await audit({ actorId: user.id, action: 'document.support_delete', entityType: 'support_document', entityId: id, data: { title: row.title }, ip: req.ip });
    return { ok: true };
  });
}
