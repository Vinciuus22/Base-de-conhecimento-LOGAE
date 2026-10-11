import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DOCUMENT_IMPORT_MIME_TYPES } from '@shared/uploads.js';
import { config } from '../../config.js';
import { query, queryOne, withTransaction } from '../../db/pool.js';
import { allowedVisibilities, requirePermission, type AuthUser } from '../../auth/context.js';
import { canViewDocument } from '../../auth/policies.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, notFound, validationError } from '../../lib/errors.js';
import { readMultipart } from '../../lib/multipart.js';
import { storage } from '../../lib/storage.js';
import { cleanKeywords, textToHtml, truncate } from '../../lib/text.js';
import { persistFile, validateUpload } from '../../lib/uploads.js';
import { pageQuery, parse, uuid } from '../../lib/validate.js';
import { createArticle } from '../articles/service.js';
import { enqueueDocument, indexDocumentChunks, type DocumentRow } from './service.js';

const metadataSchema = z.object({
  title: z.string().trim().min(3, 'Informe o título (mínimo 3 caracteres).').max(200),
  categoryId: z.string().uuid().nullable().optional().or(z.literal('').transform(() => null)),
  systemId: z.string().uuid().nullable().optional().or(z.literal('').transform(() => null)),
  keywords: z.array(z.string().max(60)).max(30).default([]),
  visibility: z.enum(['internal', 'external'], { errorMap: () => ({ message: 'Defina a visibilidade do documento (interno ou externo).' }) }),
});

async function serializeDocument(d: DocumentRow, user: AuthUser | null, includeText: boolean) {
  const extra = await queryOne<{ category_name: string | null; system_name: string | null; uploader_name: string; reviewer_name: string | null; original_name: string; mime_type: string; size_bytes: string }>(
    `SELECT c.name AS category_name, s.name AS system_name, u.name AS uploader_name, r.name AS reviewer_name,
            f.original_name, f.mime_type, f.size_bytes
       FROM documents d JOIN files f ON f.id = d.file_id JOIN users u ON u.id = d.uploaded_by
       LEFT JOIN users r ON r.id = d.reviewed_by
       LEFT JOIN categories c ON c.id = d.category_id LEFT JOIN systems s ON s.id = d.system_id
      WHERE d.id = $1`,
    [d.id],
  );
  const manage = !!user?.permissions.has('documents.manage');
  const vis = allowedVisibilities(user);
  const articles = await query(
    `SELECT a.id, a.slug, a.title, a.status FROM document_articles da JOIN articles a ON a.id = da.article_id
      WHERE da.document_id = $1 ${manage ? '' : `AND a.status = 'published' AND a.visibility = ANY($2::text[])`}`,
    manage ? [d.id] : [d.id, vis],
  );
  return {
    id: d.id,
    title: d.title,
    category: d.category_id ? { id: d.category_id, name: extra?.category_name } : null,
    system: d.system_id ? { id: d.system_id, name: extra?.system_name } : null,
    keywords: d.keywords,
    visibility: d.visibility,
    status: d.status,
    reviewStatus: d.review_status,
    pageCount: d.page_count,
    warnings: d.warnings,
    errorMessage: d.error_message,
    attempts: d.attempts,
    file: { id: d.file_id, name: extra?.original_name, mimeType: extra?.mime_type, size: Number(extra?.size_bytes ?? 0), url: `/api/files/${d.file_id}?download=1` },
    uploadedBy: manage ? extra?.uploader_name : undefined,
    reviewedBy: manage ? extra?.reviewer_name : undefined,
    reviewedAt: d.reviewed_at,
    processedAt: d.processed_at,
    removedAt: d.removed_at,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    characters: d.extracted_text?.length ?? 0,
    extractedText: includeText ? d.extracted_text : undefined,
    relatedArticles: articles,
  };
}

async function loadDoc(id: string): Promise<DocumentRow | null> {
  return queryOne<DocumentRow>(`SELECT * FROM documents WHERE id = $1`, [id]);
}

export default async function documentRoutes(app: FastifyInstance): Promise<void> {
  // Importação: valida, armazena com segurança, registra e enfileira o processamento.
  app.post('/api/documents', async (req, reply) => {
    const user = requirePermission(req, 'documents.manage');
    const form = await readMultipart(req, { maxFiles: 1 });
    try {
      const file = form.files[0];
      if (!file) throw badRequest('Selecione o arquivo do documento (PDF ou DOCX).');
      const meta = parse(metadataSchema, {
        ...form.fields,
        keywords: (form.fields.keywords ?? '').split(',').map((k) => k.trim()).filter(Boolean),
      });
      const mime = await validateUpload(file, DOCUMENT_IMPORT_MIME_TYPES, config().MAX_DOCUMENT_MB * 1024 * 1024);
      if (mime === 'application/msword' && !config().DOC_CONVERSION_ENABLED) {
        throw validationError('Arquivos .doc não são suportados neste servidor. Salve o documento como .docx ou PDF.');
      }
      const duplicate = await queryOne<{ id: string; title: string }>(`SELECT id, title FROM documents WHERE sha256 = $1 AND removed_at IS NULL`, [file.sha256]);
      if (duplicate) throw conflict('DUPLICATE_DOCUMENT', `Este arquivo já foi importado como "${duplicate.title}".`, { documentId: duplicate.id });

      const doc = await withTransaction(async (client) => {
        // Insere primeiro o arquivo (proprietário = documento) e depois o documento.
        const docId = randomUUID();
        const stored = await persistFile(file, { mime, kind: 'document', ownerType: 'document', ownerId: docId, uploadedBy: user.id, generateThumbnail: false }, client);
        return (await queryOne<DocumentRow>(
          `INSERT INTO documents (id, file_id, sha256, title, category_id, system_id, keywords, visibility, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
          [docId, stored.id, file.sha256, meta.title, meta.categoryId ?? null, meta.systemId ?? null, cleanKeywords(meta.keywords), meta.visibility, user.id],
          client,
        ))!;
      });
      await audit({ actorId: user.id, action: 'document.upload', entityType: 'document', entityId: doc.id, data: { title: doc.title, visibility: doc.visibility, mime, size: file.size }, ip: req.ip });
      enqueueDocument(doc.id);
      reply.code(201);
      return { document: await serializeDocument(doc, user, false) };
    } finally {
      await form.cleanup();
    }
  });

  app.get('/api/documents', async (req) => {
    const user = req.auth;
    const q = parse(
      z.object({
        status: z.string().max(40).optional(),
        review: z.enum(['pending_review', 'approved', 'rejected']).optional(),
        q: z.string().max(100).optional(),
        removed: z.enum(['0', '1']).default('0'),
      }).merge(pageQuery),
      req.query,
    );
    const manage = !!user?.permissions.has('documents.manage');
    const where = [manage && q.removed === '1' ? 'd.removed_at IS NOT NULL' : 'd.removed_at IS NULL'];
    const values: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      values.push(v);
      where.push(sql.replace('?', `$${values.length}`));
    };
    if (!manage) {
      // Não gestores: somente documentos aprovados e com visibilidade permitida.
      where.push(`d.review_status = 'approved'`);
      add('d.visibility = ANY(?::text[])', allowedVisibilities(user));
    } else {
      if (q.status) add('d.status = ?', q.status);
      if (q.review) add('d.review_status = ?', q.review);
    }
    if (q.q) add(`immutable_unaccent(lower(d.title)) LIKE '%' || immutable_unaccent(lower(?)) || '%'`, q.q);
    values.push(q.pageSize, (q.page - 1) * q.pageSize);
    const rows = await query<DocumentRow & { total: string }>(
      `SELECT d.*, count(*) OVER () AS total FROM documents d WHERE ${where.join(' AND ')}
        ORDER BY d.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return {
      total: rows.length ? Number(rows[0]!.total) : 0,
      items: await Promise.all(rows.map((r) => serializeDocument(r, user, false))),
    };
  });

  app.get('/api/documents/:id', async (req) => {
    const { id } = parse(z.object({ id: uuid }), req.params);
    const d = await loadDoc(id);
    if (!d || !canViewDocument(req.auth, d)) throw notFound('Documento não encontrado.');
    return { document: await serializeDocument(d, req.auth, true) };
  });

  // Atualização da classificação. Tornar um documento externo exige nova aprovação.
  app.put('/api/documents/:id', async (req) => {
    const user = requirePermission(req, 'documents.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const meta = parse(metadataSchema, req.body);
    const before = await loadDoc(id);
    if (!before || before.removed_at) throw notFound('Documento não encontrado.');
    const needsReview = before.visibility === 'internal' && meta.visibility === 'external' && before.review_status === 'approved';
    const d = (await queryOne<DocumentRow>(
      `UPDATE documents SET title = $2, category_id = $3, system_id = $4, keywords = $5, visibility = $6,
              review_status = CASE WHEN $7 THEN 'pending_review' ELSE review_status END, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, meta.title, meta.categoryId ?? null, meta.systemId ?? null, cleanKeywords(meta.keywords), meta.visibility, needsReview],
    ))!;
    await indexDocumentChunks(id);
    await audit({
      actorId: user.id,
      action: 'document.update',
      entityType: 'document',
      entityId: id,
      data: { before: { title: before.title, visibility: before.visibility }, after: meta, requiresNewReview: needsReview },
      ip: req.ip,
    });
    return { document: await serializeDocument(d, user, true), requiresNewReview: needsReview };
  });

  for (const action of ['approve', 'reject'] as const) {
    app.post(`/api/documents/:id/${action}`, async (req) => {
      const user = requirePermission(req, 'documents.manage');
      const { id } = parse(z.object({ id: uuid }), req.params);
      const { notes } = parse(z.object({ notes: z.string().max(1000).optional() }), req.body ?? {});
      const d = await loadDoc(id);
      if (!d || d.removed_at) throw notFound('Documento não encontrado.');
      if (action === 'approve' && !['processed', 'processed_with_warnings'].includes(d.status)) {
        throw conflict('NOT_PROCESSED', 'O documento só pode ser aprovado após o processamento concluído.');
      }
      const updated = (await queryOne<DocumentRow>(
        `UPDATE documents SET review_status = $2, reviewed_by = $3, reviewed_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
        [id, action === 'approve' ? 'approved' : 'rejected', user.id],
      ))!;
      await indexDocumentChunks(id);
      await audit({ actorId: user.id, action: `document.${action}`, entityType: 'document', entityId: id, data: { visibility: d.visibility, notes }, ip: req.ip });
      return { document: await serializeDocument(updated, user, true) };
    });
  }

  app.post('/api/documents/:id/reprocess', async (req) => {
    const user = requirePermission(req, 'documents.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const d = await loadDoc(id);
    if (!d || d.removed_at) throw notFound('Documento não encontrado.');
    if (d.status === 'processing') throw conflict('PROCESSING', 'O documento já está em processamento.');
    // Reprocessar invalida a revisão anterior: o novo texto precisa ser revisado.
    await query(`UPDATE documents SET status = 'pending', review_status = 'pending_review', updated_at = now() WHERE id = $1`, [id]);
    await query(`UPDATE content_chunks SET available = false WHERE source_type = 'document' AND source_id = $1`, [id]);
    await audit({ actorId: user.id, action: 'document.reprocess', entityType: 'document', entityId: id, ip: req.ip });
    enqueueDocument(id);
    return { ok: true };
  });

  // Remoção: retira o documento da pesquisa/IA e apaga o arquivo; mantém o registro para rastreabilidade.
  app.delete('/api/documents/:id', async (req) => {
    const user = requirePermission(req, 'documents.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'Informe o motivo da remoção.').max(500) }), req.body ?? {});
    const d = await loadDoc(id);
    if (!d || d.removed_at) throw notFound('Documento não encontrado.');
    const file = await queryOne<{ storage_key: string }>(`SELECT storage_key FROM files WHERE id = $1`, [d.file_id]);
    await withTransaction(async (client) => {
      await client.query(`UPDATE documents SET removed_at = now(), removed_by = $2, updated_at = now() WHERE id = $1`, [id, user.id]);
      await client.query(`DELETE FROM content_chunks WHERE source_type = 'document' AND source_id = $1`, [id]);
      await client.query(`UPDATE files SET deleted_at = now() WHERE id = $1`, [d.file_id]);
    });
    if (file) await storage().remove(file.storage_key).catch(() => undefined);
    await audit({ actorId: user.id, action: 'document.remove', entityType: 'document', entityId: id, data: { title: d.title, reason }, ip: req.ip });
    return { ok: true };
  });

  // Gera um rascunho de artigo a partir do texto extraído (rastreabilidade documento → artigo).
  app.post('/api/documents/:id/create-article', async (req, reply) => {
    const user = requirePermission(req, 'documents.manage', 'articles.create');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const d = await loadDoc(id);
    if (!d || d.removed_at) throw notFound('Documento não encontrado.');
    if (!d.extracted_text) throw conflict('NO_TEXT', 'O documento não possui texto extraído.');
    const article = await withTransaction(async (client) => {
      const a = await createArticle(
        user,
        {
          title: d.title,
          summary: truncate(d.extracted_text!.replace(/\s+/g, ' '), 300),
          contentHtml: `<div data-callout="info"><p>Rascunho gerado a partir do documento importado "${d.title.replace(/[<>&"]/g, '')}". Revise antes de publicar.</p></div>${textToHtml(d.extracted_text!)}`,
          categoryId: d.category_id,
          systemId: d.system_id,
          keywords: d.keywords,
          tags: [],
          visibility: d.visibility,
        },
        client,
      );
      await client.query(`INSERT INTO document_articles (document_id, article_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, a.id]);
      return a;
    });
    await audit({ actorId: user.id, action: 'document.article_created', entityType: 'document', entityId: id, data: { articleId: article.id }, ip: req.ip });
    reply.code(201);
    return { article: { id: article.id, slug: article.slug } };
  });

  app.post('/api/documents/:id/articles', async (req) => {
    const user = requirePermission(req, 'documents.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { articleId } = parse(z.object({ articleId: uuid }), req.body);
    const d = await loadDoc(id);
    if (!d || d.removed_at) throw notFound('Documento não encontrado.');
    const a = await queryOne(`SELECT 1 FROM articles WHERE id = $1`, [articleId]);
    if (!a) throw notFound('Artigo não encontrado.');
    await query(`INSERT INTO document_articles (document_id, article_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, articleId]);
    await audit({ actorId: user.id, action: 'document.article_linked', entityType: 'document', entityId: id, data: { articleId }, ip: req.ip });
    return { ok: true };
  });
}
