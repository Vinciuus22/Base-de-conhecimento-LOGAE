import { query } from '../../db/pool.js';
import type { AuthUser } from '../../auth/context.js';
import { allowedVisibilities } from '../../auth/context.js';
import { anonymousAllowed } from '../../auth/policies.js';
import { buildTsQueries } from '../articles/search.js';
import { cosine, embed, embeddingsEnabled } from './embeddings.js';

export interface RetrievedChunk {
  chunkId: string;
  sourceType: 'article' | 'document';
  sourceId: string;
  title: string;
  url: string;
  heading: string | null;
  content: string;
  visibility: 'internal' | 'external';
  coverage: number;
  rank: number;
  semantic: number;
}

/** Visibilidades que o chat do usuário pode consultar (decidido no backend, não pelo modelo). */
export function chatAudience(user: AuthUser | null): Array<'internal' | 'external'> {
  if (!anonymousAllowed(user)) return [];
  return allowedVisibilities(user);
}

/**
 * Recupera trechos AUTORIZADOS para a pergunta.
 *
 * O filtro de visibilidade é aplicado em duas camadas na mesma consulta:
 *  1) metadados do trecho (visibilidade e disponibilidade);
 *  2) estado ATUAL da fonte (artigo publicado / documento aprovado e não removido,
 *     com visibilidade permitida). Um trecho desatualizado nunca é retornado.
 */
export async function retrieveChunks(user: AuthUser | null, question: string, limit = 6): Promise<RetrievedChunk[]> {
  const audience = chatAudience(user);
  if (!audience.length) return [];
  const { orQuery } = await buildTsQueries(question);
  const lexemes = orQuery ? [...orQuery.matchAll(/'([^']+)'(:\*)?/g)].map((m) => m[1]!) : [];

  const chunkSql = (extraSelect: string, extraWhere: string) => `
    SELECT ${extraSelect} ch.id, ch.source_type, ch.source_id, ch.heading, ch.content, ch.visibility, ch.embedding,
           coalesce(a.title, d.title) AS title, a.slug AS article_slug
      FROM content_chunks ch
      LEFT JOIN articles a ON ch.source_type = 'article' AND a.id = ch.source_id
            AND a.status = 'published' AND a.visibility = ANY($1::text[]) AND a.visibility = ch.visibility
      LEFT JOIN documents d ON ch.source_type = 'document' AND d.id = ch.source_id
            AND d.review_status = 'approved' AND d.removed_at IS NULL AND d.visibility = ANY($1::text[]) AND d.visibility = ch.visibility
     WHERE ch.available = true AND ch.visibility = ANY($1::text[]) AND (a.id IS NOT NULL OR d.id IS NOT NULL) ${extraWhere}`;

  const candidates = new Map<string, RetrievedChunk & { embedding: number[] | null }>();
  const toChunk = (r: Record<string, unknown>, coverage: number, rank: number): RetrievedChunk & { embedding: number[] | null } => ({
    chunkId: r.id as string,
    sourceType: r.source_type as 'article' | 'document',
    sourceId: r.source_id as string,
    title: r.title as string,
    url: r.source_type === 'article' ? `/artigos/${r.article_slug as string}` : `/documentos/${r.source_id as string}`,
    heading: (r.heading as string) ?? null,
    content: r.content as string,
    visibility: r.visibility as 'internal' | 'external',
    coverage,
    rank,
    semantic: 0,
    embedding: (r.embedding as number[] | null) ?? null,
  });

  if (orQuery && lexemes.length) {
    const rows = await query(
      `${chunkSql(
        `(SELECT count(*) FROM unnest($3::text[]) l
           WHERE ch.search_vector @@ (quote_literal(l) || CASE WHEN length(l) >= 4 THEN ':*' ELSE '' END)::tsquery)::float
           / greatest(cardinality($3::text[]), 1) AS coverage,
         ts_rank_cd(ch.search_vector, $2::text::tsquery, 32) AS rank,`,
        'AND ch.search_vector @@ $2::text::tsquery',
      )} ORDER BY coverage DESC, rank DESC LIMIT 30`,
      [audience, orQuery, lexemes],
    );
    for (const r of rows) candidates.set(r.id, toChunk(r, Number(r.coverage), Number(r.rank)));
  }

  if (embeddingsEnabled()) {
    try {
      const [qv] = await embed([question], 'query');
      const rows = await query(chunkSql('', 'AND ch.embedding IS NOT NULL'), [audience]);
      for (const r of rows) {
        const sim = cosine(qv!, r.embedding as number[]);
        const existing = candidates.get(r.id);
        if (existing) existing.semantic = sim;
        else if (sim >= 0.55) candidates.set(r.id, { ...toChunk(r, 0, 0), semantic: sim });
      }
    } catch (err) {
      console.error('[retrieval] pesquisa semântica indisponível:', (err as Error).message);
    }
  }

  // Limiar de relevância: metade dos termos da pergunta presentes ou forte similaridade semântica.
  const relevant = [...candidates.values()].filter((c) => c.coverage >= 0.5 || c.semantic >= 0.55);
  relevant.sort((a, b) => b.coverage + b.rank + b.semantic * 1.5 - (a.coverage + a.rank + a.semantic * 1.5));

  // No máximo 3 trechos por fonte, para diversificar as referências.
  const perSource = new Map<string, number>();
  const out: RetrievedChunk[] = [];
  for (const c of relevant) {
    const n = perSource.get(c.sourceId) ?? 0;
    if (n >= 3) continue;
    perSource.set(c.sourceId, n + 1);
    const { embedding: _e, ...chunk } = c;
    out.push(chunk);
    if (out.length >= limit) break;
  }
  return out;
}
