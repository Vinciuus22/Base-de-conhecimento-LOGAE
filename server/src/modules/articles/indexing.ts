import { type Db } from '../../db/pool.js';
import { chunkText, extractHeadings } from '../../lib/text.js';
import { scheduleEmbeddings } from '../ai/embeddings.js';

/**
 * Reindexa os trechos de um artigo para pesquisa e IA.
 * Somente artigos PUBLICADOS geram trechos disponíveis; rascunhos, despublicados
 * e arquivados têm os trechos removidos. A visibilidade é copiada para cada trecho.
 */
export async function reindexArticle(db: Db, articleId: string): Promise<void> {
  await db.query(`SELECT article_refresh_search_vector($1)`, [articleId]);
  await db.query(`DELETE FROM content_chunks WHERE source_type = 'article' AND source_id = $1`, [articleId]);
  const res = await db.query<{ status: string; visibility: string; title: string; summary: string; content_html: string; content_text: string }>(
    `SELECT status, visibility, title, summary, content_html, content_text FROM articles WHERE id = $1`,
    [articleId],
  );
  const a = res.rows[0];
  if (!a || a.status !== 'published') return;
  const text = `${a.summary}\n${a.content_text}`;
  const chunks = chunkText(text, { headings: extractHeadings(a.content_html) });
  let i = 0;
  for (const c of chunks) {
    await db.query(
      `INSERT INTO content_chunks (source_type, source_id, chunk_index, heading, content, visibility, available)
       VALUES ('article', $1, $2, $3, $4, $5, true)`,
      [articleId, i++, c.heading ? `${a.title} — ${c.heading}` : a.title, c.content, a.visibility],
    );
  }
  scheduleEmbeddings();
}
