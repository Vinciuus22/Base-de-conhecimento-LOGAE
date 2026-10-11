import { type Db, getPool, query } from '../../db/pool.js';
import type { AuthUser } from '../../auth/context.js';
import { allowedVisibilities } from '../../auth/context.js';
import { anonymousAllowed } from '../../auth/policies.js';
import { normalize } from '../../lib/text.js';
import { cosine, embed, embeddingsEnabled } from '../ai/embeddings.js';

export interface SearchParams {
  q: string;
  categoryId?: string | null;
  systemId?: string | null;
  tag?: string | null;
  visibility?: 'internal' | 'external' | null;
  from?: Date | null;
  to?: Date | null;
  page: number;
  pageSize: number;
}

export interface SearchResult {
  id: string;
  slug: string;
  title: string;
  summary: string;
  updatedAt: Date;
  visibility: string;
  category: { id: string; name: string; slug: string } | null;
  system: { id: string; name: string } | null;
  tags: string[];
  /** Trecho do conteúdo com os termos marcados entre \u0002 e \u0003. */
  headline: string;
  score: number;
  matchType: 'text' | 'fuzzy' | 'semantic';
}

/** Marcadores usados pelo ts_headline (o frontend converte em <mark> com escape seguro). */
export const HL_START = '\u0002';
export const HL_END = '\u0003';

function quoteLexeme(l: string): string {
  return `'${l.replace(/'/g, "''").replace(/\\/g, '')}'`;
}

/** Palavras normalizadas (sem acento, minúsculas) da consulta. */
export function queryWords(q: string): string[] {
  return [...new Set(normalize(q).split(/[^a-z0-9]+/).filter((w) => w.length >= 2))].slice(0, 12);
}

/**
 * Monta as consultas tsquery:
 *  - AND: todos os termos (stemming em português, sem acentos);
 *  - OR: qualquer termo, com correspondência por prefixo e sinônimos cadastrados.
 */
export async function buildTsQueries(q: string, db: Db = getPool()): Promise<{ andQuery: string | null; orQuery: string | null; expandedTerms: string[] }> {
  const words = queryWords(q);
  if (!words.length) return { andQuery: null, orQuery: null, expandedTerms: [] };

  const synonymRows = await query<{ term: string; synonyms: string[] }>(
    `SELECT term, synonyms FROM search_synonyms
      WHERE lower(immutable_unaccent(term)) = ANY($1::text[])
         OR EXISTS (SELECT 1 FROM unnest(synonyms) s WHERE lower(immutable_unaccent(s)) = ANY($1::text[]))`,
    [words],
    db,
  );
  const expanded = new Set<string>();
  for (const r of synonymRows) {
    for (const t of [r.term, ...r.synonyms]) if (!words.includes(normalize(t))) expanded.add(t);
  }

  const lexRows = await query<{ lexeme: string }>(
    `SELECT DISTINCT unnest(tsvector_to_array(to_tsvector('pt_unaccent', $1))) AS lexeme`,
    [words.join(' ')],
    db,
  );
  const synLexRows = expanded.size
    ? await query<{ lexeme: string }>(`SELECT DISTINCT unnest(tsvector_to_array(to_tsvector('pt_unaccent', $1))) AS lexeme`, [[...expanded].join(' ')], db)
    : [];
  const lexemes = lexRows.map((r) => r.lexeme).filter((l) => /^[a-z0-9]+$/.test(l));
  const synLexemes = synLexRows.map((r) => r.lexeme).filter((l) => /^[a-z0-9]+$/.test(l) && !lexemes.includes(l));
  if (!lexemes.length && !synLexemes.length) return { andQuery: null, orQuery: null, expandedTerms: [...expanded] };

  const term = (l: string) => (l.length >= 4 ? `${quoteLexeme(l)}:*` : quoteLexeme(l));
  return {
    andQuery: lexemes.length ? lexemes.map(term).join(' & ') : null,
    orQuery: [...lexemes, ...synLexemes].map(term).join(' | '),
    expandedTerms: [...expanded],
  };
}

/**
 * Filtro de visibilidade aplicado na consulta SQL (nunca no frontend):
 * a pesquisa só retorna artigos PUBLICADOS cuja visibilidade o usuário pode ver.
 */
function visibilityFilter(user: AuthUser | null, requested: 'internal' | 'external' | null | undefined): string[] {
  const allowed = allowedVisibilities(user);
  if (requested) return allowed.includes(requested) ? [requested] : [];
  return allowed;
}

export async function searchArticles(user: AuthUser | null, params: SearchParams) {
  const visibilities = anonymousAllowed(user) ? visibilityFilter(user, params.visibility) : [];
  const empty = { results: [] as SearchResult[], total: 0, suggestions: [] as string[], expandedTerms: [] as string[], terms: [] as string[], semantic: false };
  if (!visibilities.length) return empty;

  const qText = params.q.trim().slice(0, 300);
  const { andQuery, orQuery, expandedTerms } = await buildTsQueries(qText);
  const normalizedQ = normalize(qText);
  const filters: string[] = [`a.status = 'published'`, `a.visibility = ANY($1::text[])`];
  const values: unknown[] = [visibilities];
  const add = (sql: string, v: unknown) => {
    values.push(v);
    filters.push(sql.replace('?', `$${values.length}`));
  };
  if (params.categoryId) add('a.category_id = ?', params.categoryId);
  if (params.systemId) add('a.system_id = ?', params.systemId);
  if (params.tag) add('EXISTS (SELECT 1 FROM article_tags at2 JOIN tags t2 ON t2.id = at2.tag_id WHERE at2.article_id = a.id AND t2.slug = ?)', params.tag);
  if (params.from) add('a.updated_at >= ?', params.from);
  if (params.to) add('a.updated_at <= ?', params.to);

  values.push(andQuery, orQuery, normalizedQ);
  const iAnd = values.length - 2;
  const iOr = values.length - 1;
  const iNorm = values.length;
  values.push(params.pageSize, (params.page - 1) * params.pageSize);
  const iLimit = values.length - 1;
  const iOffset = values.length;

  const hasQuery = !!normalizedQ;
  const matchClause = hasQuery
    ? `AND (
         ($${iOr}::text IS NOT NULL AND a.search_vector @@ $${iOr}::text::tsquery)
         OR similarity(immutable_unaccent(lower(a.title)), $${iNorm}) > 0.3
         OR word_similarity($${iNorm}, immutable_unaccent(lower(a.title || ' ' || array_to_string(a.keywords, ' ')))) > 0.6
       )`
    : '';

  const rows = await query<{
    id: string;
    slug: string;
    title: string;
    summary: string;
    updated_at: Date;
    visibility: string;
    category_id: string | null;
    category_name: string | null;
    category_slug: string | null;
    system_id: string | null;
    system_name: string | null;
    tags: string[] | null;
    headline: string;
    score: number;
    text_match: boolean;
    total: string;
  }>(
    `SELECT a.id, a.slug, a.title, a.summary, a.updated_at, a.visibility,
            c.id AS category_id, c.name AS category_name, c.slug AS category_slug,
            s.id AS system_id, s.name AS system_name,
            (SELECT array_agg(t.name ORDER BY t.name) FROM article_tags at JOIN tags t ON t.id = at.tag_id WHERE at.article_id = a.id) AS tags,
            CASE WHEN $${iOr}::text IS NOT NULL
                 THEN ts_headline('pt_unaccent', a.content_text, $${iOr}::text::tsquery,
                        'StartSel=${HL_START}, StopSel=${HL_END}, MaxFragments=2, MaxWords=28, MinWords=10, FragmentDelimiter=" … "')
                 ELSE left(a.content_text, 220) END AS headline,
            ${
              hasQuery
                ? `(CASE WHEN $${iOr}::text IS NOT NULL THEN ts_rank_cd(a.search_vector, $${iOr}::text::tsquery, 32) ELSE 0 END)
                   + (CASE WHEN $${iAnd}::text IS NOT NULL AND a.search_vector @@ $${iAnd}::text::tsquery THEN 1.0 ELSE 0 END)
                   + similarity(immutable_unaccent(lower(a.title)), $${iNorm}) * 0.8
                   + ln(1 + a.view_count) * 0.01`
                : `ln(1 + a.view_count) * 0.01`
            } AS score,
            ($${iOr}::text IS NOT NULL AND a.search_vector @@ $${iOr}::text::tsquery) AS text_match,
            count(*) OVER () AS total
       FROM articles a
       LEFT JOIN categories c ON c.id = a.category_id
       LEFT JOIN systems s ON s.id = a.system_id
      WHERE ${filters.join(' AND ')} ${matchClause}
      ORDER BY ${hasQuery ? 'score DESC,' : ''} a.updated_at DESC
      LIMIT $${iLimit} OFFSET $${iOffset}`,
    values,
  );

  const results: SearchResult[] = rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    summary: r.summary,
    updatedAt: r.updated_at,
    visibility: r.visibility,
    category: r.category_id ? { id: r.category_id, name: r.category_name!, slug: r.category_slug! } : null,
    system: r.system_id ? { id: r.system_id, name: r.system_name! } : null,
    tags: r.tags ?? [],
    headline: r.headline,
    score: Number(r.score),
    matchType: r.text_match ? 'text' : 'fuzzy',
  }));
  let total = rows.length ? Number(rows[0]!.total) : 0;

  // Complemento semântico (quando configurado): adiciona artigos relacionados por significado.
  let semantic = false;
  if (hasQuery && params.page === 1 && embeddingsEnabled()) {
    try {
      const extra = await semanticArticleMatches(visibilities, qText, results.map((r) => r.id), params);
      semantic = true;
      results.push(...extra);
      total += extra.length;
    } catch (err) {
      console.error('[search] pesquisa semântica indisponível:', (err as Error).message);
    }
  }

  const suggestions = hasQuery && total < 3 ? await suggestTerms(visibilities, qText) : [];
  return { results, total, suggestions, expandedTerms, terms: queryWords(qText), semantic };
}

async function semanticArticleMatches(
  visibilities: string[],
  q: string,
  excludeIds: string[],
  params: SearchParams,
): Promise<SearchResult[]> {
  const [vector] = await embed([q], 'query');
  const chunks = await query<{ source_id: string; embedding: number[] }>(
    `SELECT ch.source_id, ch.embedding
       FROM content_chunks ch
       JOIN articles a ON a.id = ch.source_id
      WHERE ch.source_type = 'article' AND ch.available AND ch.embedding IS NOT NULL
        AND a.status = 'published' AND a.visibility = ANY($1::text[]) AND ch.visibility = a.visibility
        AND NOT (a.id = ANY($2::uuid[]))
        AND ($3::uuid IS NULL OR a.category_id = $3) AND ($4::uuid IS NULL OR a.system_id = $4)`,
    [visibilities, excludeIds, params.categoryId ?? null, params.systemId ?? null],
  );
  const best = new Map<string, number>();
  for (const c of chunks) {
    const s = cosine(vector!, c.embedding);
    if (s > (best.get(c.source_id) ?? 0)) best.set(c.source_id, s);
  }
  const top = [...best.entries()].filter(([, s]) => s >= 0.5).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (!top.length) return [];
  const rows = await query<{
    id: string; slug: string; title: string; summary: string; updated_at: Date; visibility: string;
    category_id: string | null; category_name: string | null; category_slug: string | null; system_id: string | null; system_name: string | null;
  }>(
    `SELECT a.id, a.slug, a.title, a.summary, a.updated_at, a.visibility, c.id AS category_id, c.name AS category_name, c.slug AS category_slug,
            s.id AS system_id, s.name AS system_name
       FROM articles a LEFT JOIN categories c ON c.id = a.category_id LEFT JOIN systems s ON s.id = a.system_id
      WHERE a.id = ANY($1::uuid[]) AND a.status = 'published' AND a.visibility = ANY($2::text[])`,
    [top.map(([id]) => id), visibilities],
  );
  return top
    .map(([id, score]) => {
      const r = rows.find((x) => x.id === id);
      if (!r) return null;
      return {
        id: r.id, slug: r.slug, title: r.title, summary: r.summary, updatedAt: r.updated_at, visibility: r.visibility,
        category: r.category_id ? { id: r.category_id, name: r.category_name!, slug: r.category_slug! } : null,
        system: r.system_id ? { id: r.system_id, name: r.system_name! } : null,
        tags: [], headline: r.summary, score, matchType: 'semantic' as const,
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
}

/**
 * Sugestões de termos alternativos ("Você quis dizer…") calculadas SOMENTE a
 * partir de artigos que o usuário pode ver, para não vazar termos internos.
 */
export async function suggestTerms(visibilities: string[], q: string): Promise<string[]> {
  const words = queryWords(q).filter((w) => w.length >= 3);
  if (!words.length) return [];
  const replacements = new Map<string, string>();
  for (const word of words) {
    const row = await query<{ w: string; sim: number }>(
      `SELECT w, similarity(w, $2) AS sim FROM (
         SELECT DISTINCT regexp_split_to_table(
           immutable_unaccent(lower(a.title || ' ' || array_to_string(a.keywords, ' ') || ' ' || coalesce(c.name, '') || ' ' || coalesce(s.name, ''))),
           '[^a-z0-9]+') AS w
           FROM articles a
           LEFT JOIN categories c ON c.id = a.category_id
           LEFT JOIN systems s ON s.id = a.system_id
          WHERE a.status = 'published' AND a.visibility = ANY($1::text[])
       ) words
       WHERE length(w) >= 3 AND similarity(w, $2) > 0.4
       ORDER BY sim DESC LIMIT 1`,
      [visibilities, word],
    );
    const best = row[0];
    // Ignora quando a palavra já existe no vocabulário ou é apenas uma variação (mesmo radical).
    if (best && best.w !== word) {
      const sameStem = await query<{ same: boolean }>(
        `SELECT tsvector_to_array(to_tsvector('pt_unaccent', $1)) = tsvector_to_array(to_tsvector('pt_unaccent', $2)) AS same`,
        [best.w, word],
      );
      if (!sameStem[0]?.same) replacements.set(word, best.w);
    }
  }
  if (!replacements.size) {
    // Sinônimos cadastrados como termos alternativos.
    const syn = await query<{ term: string; synonyms: string[] }>(
      `SELECT term, synonyms FROM search_synonyms WHERE lower(immutable_unaccent(term)) = ANY($1::text[])`,
      [words],
    );
    return syn.flatMap((s) => s.synonyms).slice(0, 5);
  }
  const suggestion = queryWords(q)
    .map((w) => replacements.get(w) ?? w)
    .join(' ');
  return suggestion && suggestion !== normalize(q) ? [suggestion] : [];
}
