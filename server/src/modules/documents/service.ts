import { Readable } from 'node:stream';
import { query, queryOne, withTransaction } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { storage } from '../../lib/storage.js';
import { chunkText } from '../../lib/text.js';
import { scheduleEmbeddings } from '../ai/embeddings.js';
import { extractDocumentText, ExtractionError } from './extract.js';

export interface DocumentRow {
  id: string;
  file_id: string;
  sha256: string;
  title: string;
  category_id: string | null;
  system_id: string | null;
  keywords: string[];
  visibility: 'internal' | 'external';
  status: string;
  review_status: string;
  extracted_text: string | null;
  page_count: number | null;
  warnings: string[];
  error_message: string | null;
  attempts: number;
  uploaded_by: string;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  processed_at: Date | null;
  removed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

/**
 * Indexa os trechos do documento. Ficam DISPONÍVEIS para pesquisa/IA somente
 * após a aprovação (revisão humana), com a visibilidade do documento.
 */
export async function indexDocumentChunks(documentId: string): Promise<void> {
  await withTransaction(async (client) => {
    const doc = await queryOne<DocumentRow>(`SELECT * FROM documents WHERE id = $1 FOR UPDATE`, [documentId], client);
    await client.query(`DELETE FROM content_chunks WHERE source_type = 'document' AND source_id = $1`, [documentId]);
    if (!doc || doc.removed_at || !doc.extracted_text || !['processed', 'processed_with_warnings'].includes(doc.status)) return;
    const available = doc.review_status === 'approved';
    const chunks = chunkText(doc.extracted_text, { maxChars: 1200, overlap: 150 });
    let i = 0;
    for (const c of chunks) {
      await client.query(
        `INSERT INTO content_chunks (source_type, source_id, chunk_index, heading, content, visibility, available)
         VALUES ('document', $1, $2, $3, $4, $5, $6)`,
        [documentId, i++, doc.title, c.content, doc.visibility, available],
      );
    }
  });
  scheduleEmbeddings();
}

/** Processa (extrai texto e indexa) um documento. Atualiza o status em cada etapa. */
export async function processDocument(documentId: string): Promise<void> {
  const claimed = await queryOne<DocumentRow & { mime_type: string; storage_key: string }>(
    `UPDATE documents d SET status = 'processing', attempts = attempts + 1, error_message = NULL, updated_at = now()
       FROM files f
      WHERE d.id = $1 AND f.id = d.file_id AND d.removed_at IS NULL AND d.status IN ('pending', 'failed', 'processed', 'processed_with_warnings')
      RETURNING d.*, f.mime_type, f.storage_key`,
    [documentId],
  );
  if (!claimed) return;
  try {
    const data = await readAll(await storage().read(claimed.storage_key));
    const result = await extractDocumentText(data, claimed.mime_type);
    await query(
      `UPDATE documents SET status = $2, extracted_text = $3, page_count = $4, warnings = $5, processed_at = now(), updated_at = now()
        WHERE id = $1`,
      [documentId, result.warnings.length ? 'processed_with_warnings' : 'processed', result.text, result.pageCount, JSON.stringify(result.warnings)],
    );
    await indexDocumentChunks(documentId);
    await audit({ actorId: null, action: 'document.processed', entityType: 'document', entityId: documentId, data: { warnings: result.warnings.length, characters: result.text.length } });
  } catch (err) {
    const message = err instanceof ExtractionError ? err.message : 'Erro inesperado durante o processamento. Tente reprocessar o documento.';
    if (!(err instanceof ExtractionError)) console.error('[documents] falha no processamento:', err);
    await query(
      `UPDATE documents SET status = 'failed', error_message = $2, extracted_text = NULL, processed_at = now(), updated_at = now() WHERE id = $1`,
      [documentId, message],
    );
    await query(`DELETE FROM content_chunks WHERE source_type = 'document' AND source_id = $1`, [documentId]);
    await audit({ actorId: null, action: 'document.processing_failed', entityType: 'document', entityId: documentId, data: { message } });
  }
}

// Fila simples em processo. Em produção com várias instâncias, os documentos
// pendentes são retomados na inicialização (ver resumePendingDocuments).
const queue: string[] = [];
let working = false;
const waiters: Array<() => void> = [];

export function enqueueDocument(id: string): void {
  if (!queue.includes(id)) queue.push(id);
  void drain();
}

async function drain(): Promise<void> {
  if (working) return;
  working = true;
  try {
    while (queue.length) {
      const id = queue.shift()!;
      await processDocument(id).catch((err) => console.error('[documents]', err));
    }
  } finally {
    working = false;
    while (waiters.length) waiters.shift()!();
  }
}

/** Aguarda a fila esvaziar (usado em testes). */
export async function waitForDocumentQueue(): Promise<void> {
  if (!working && !queue.length) return;
  await new Promise<void>((resolve) => waiters.push(resolve));
}

export async function resumePendingDocuments(): Promise<void> {
  // Documentos que ficaram "em processamento" por queda do servidor voltam para a fila.
  const rows = await query<{ id: string }>(
    `UPDATE documents SET status = 'pending' WHERE removed_at IS NULL AND (status = 'pending' OR (status = 'processing' AND updated_at < now() - interval '10 minutes')) RETURNING id`,
  );
  for (const r of rows) enqueueDocument(r.id);
}

