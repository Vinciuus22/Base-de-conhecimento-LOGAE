import type pg from 'pg';
import { z } from 'zod';
import type { ArticleOperation } from '@shared/domain.js';
import { type Db, getPool, query, queryOne } from '../../db/pool.js';
import type { AuthUser } from '../../auth/context.js';
import { canEditArticle, canViewArticle } from '../../auth/policies.js';
import { conflict, forbidden, notFound, validationError } from '../../lib/errors.js';
import { MAX_CONTENT_HTML_LENGTH, referencedFileIds, sanitizeRichHtml } from '../../lib/sanitize.js';
import { cleanKeywords, htmlToText, slugify } from '../../lib/text.js';
import { reindexArticle } from './indexing.js';

export interface ArticleRow {
  id: string;
  slug: string;
  title: string;
  summary: string;
  content_html: string;
  content_text: string;
  category_id: string | null;
  system_id: string | null;
  keywords: string[];
  status: 'draft' | 'published' | 'unpublished' | 'archived';
  visibility: 'internal' | 'external';
  author_id: string;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
  published_at: Date | null;
  published_by: string | null;
  version: number;
  view_count: string;
}

export const articleInputSchema = z.object({
  title: z.string().trim().min(3, 'O título deve ter pelo menos 3 caracteres.').max(200, 'O título deve ter no máximo 200 caracteres.'),
  summary: z.string().trim().max(1000, 'O resumo deve ter no máximo 1000 caracteres.').default(''),
  contentHtml: z.string().max(MAX_CONTENT_HTML_LENGTH, 'O conteúdo excede o tamanho máximo permitido.').default(''),
  categoryId: z.string().uuid('Categoria inválida.').nullable().optional().transform((v) => v ?? null),
  systemId: z.string().uuid('Sistema inválido.').nullable().optional().transform((v) => v ?? null),
  keywords: z.array(z.string().max(60)).max(30).default([]),
  tags: z.array(z.string().max(60)).max(20).default([]),
  visibility: z.enum(['internal', 'external'], { errorMap: () => ({ message: 'Defina a visibilidade (interno ou externo).' }) }),
});
export type ArticleInput = z.infer<typeof articleInputSchema>;

export interface NormalizedArticle {
  title: string;
  summary: string;
  contentHtml: string;
  contentText: string;
  categoryId: string | null;
  systemId: string | null;
  keywords: string[];
  tagIds: string[];
  tagNames: string[];
  visibility: 'internal' | 'external';
}

/** Sanitiza e valida as referências (categoria, sistema e tags). */
export async function normalizeArticleInput(user: AuthUser, input: ArticleInput, db: Db): Promise<NormalizedArticle> {
  const contentHtml = sanitizeRichHtml(input.contentHtml);
  // Remove marcadores de controle usados no destaque dos resultados de pesquisa.
  const contentText = htmlToText(contentHtml).replace(/[\u0002\u0003]/g, '');

  if (input.categoryId && !(await queryOne(`SELECT 1 FROM categories WHERE id = $1`, [input.categoryId], db))) {
    throw validationError('Categoria não encontrada.', { fields: { categoryId: 'Categoria não encontrada.' } });
  }
  if (input.systemId && !(await queryOne(`SELECT 1 FROM systems WHERE id = $1`, [input.systemId], db))) {
    throw validationError('Sistema não encontrado.', { fields: { systemId: 'Sistema não encontrado.' } });
  }

  const tagNames = cleanKeywords(input.tags);
  const tagIds: string[] = [];
  const finalTagNames: string[] = [];
  for (const name of tagNames) {
    const slug = slugify(name, 60);
    let tag = await queryOne<{ id: string; name: string }>(`SELECT id, name FROM tags WHERE slug = $1`, [slug], db);
    if (!tag) {
      if (!user.permissions.has('categories.manage')) {
        throw validationError(`A tag "${name}" não existe. Solicite o cadastro a um usuário com permissão para gerenciar categorias.`, {
          fields: { tags: `Tag inexistente: ${name}` },
        });
      }
      tag = await queryOne<{ id: string; name: string }>(
        `INSERT INTO tags (name, slug) VALUES ($1, $2) ON CONFLICT (slug) DO UPDATE SET name = tags.name RETURNING id, name`,
        [name, slug],
        db,
      );
    }
    tagIds.push(tag!.id);
    finalTagNames.push(tag!.name);
  }

  return {
    title: input.title,
    summary: input.summary,
    contentHtml,
    contentText,
    categoryId: input.categoryId,
    systemId: input.systemId,
    keywords: cleanKeywords(input.keywords),
    tagIds,
    tagNames: finalTagNames,
    visibility: input.visibility,
  };
}

/** Campos obrigatórios para publicação (validados no backend). */
export function publicationErrors(a: {
  title: string;
  summary: string;
  content_text: string;
  category_id: string | null;
  system_id: string | null;
  keywords: string[];
  visibility: string;
}): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!a.title?.trim()) errors.title = 'Informe o título.';
  if (!a.summary?.trim()) errors.summary = 'Informe o resumo.';
  if (!a.content_text?.trim()) errors.contentHtml = 'O conteúdo não pode estar vazio.';
  if (!a.category_id) errors.categoryId = 'Selecione a categoria.';
  if (!a.system_id) errors.systemId = 'Selecione o sistema relacionado.';
  if (!a.keywords?.length) errors.keywords = 'Informe pelo menos uma palavra-chave.';
  if (!['internal', 'external'].includes(a.visibility)) errors.visibility = 'Defina a visibilidade.';
  return errors;
}

async function uniqueSlug(title: string, db: Db): Promise<string> {
  const base = slugify(title);
  let slug = base;
  for (let i = 2; await queryOne(`SELECT 1 FROM articles WHERE slug = $1`, [slug], db); i++) slug = `${base}-${i}`;
  return slug;
}

export async function getArticleTags(articleId: string, db: Db = getPool()): Promise<Array<{ id: string; name: string; slug: string }>> {
  return query(
    `SELECT t.id, t.name, t.slug FROM article_tags at JOIN tags t ON t.id = at.tag_id WHERE at.article_id = $1 ORDER BY t.name`,
    [articleId],
    db,
  );
}

async function setTags(articleId: string, tagIds: string[], db: Db): Promise<void> {
  await db.query(`DELETE FROM article_tags WHERE article_id = $1`, [articleId]);
  for (const tagId of tagIds) {
    await db.query(`INSERT INTO article_tags (article_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [articleId, tagId]);
  }
}

/** Vincula ao artigo os arquivos enviados pelo usuário e referenciados no conteúdo. */
export async function linkContentFiles(
  html: string,
  ownerType: 'article' | 'announcement',
  ownerId: string,
  userId: string,
  db: Db,
): Promise<void> {
  const ids = referencedFileIds(html);
  if (!ids.length) return;
  await db.query(
    `UPDATE files SET owner_type = $1, owner_id = $2
      WHERE (id = ANY($3::uuid[]) OR parent_file_id = ANY($3::uuid[]))
        AND owner_id IS NULL AND uploaded_by = $4`,
    [ownerType, ownerId, ids, userId],
  );
}

export async function insertVersionSnapshot(db: Db, articleId: string, userId: string): Promise<void> {
  await db.query(
    `INSERT INTO article_versions (article_id, version, title, summary, content_html, content_text, category_id, system_id,
                                   keywords, tags, status, visibility, created_by)
     SELECT a.id, a.version, a.title, a.summary, a.content_html, a.content_text, a.category_id, a.system_id, a.keywords,
            coalesce((SELECT array_agg(t.name ORDER BY t.name) FROM article_tags at JOIN tags t ON t.id = at.tag_id WHERE at.article_id = a.id), '{}'),
            a.status, a.visibility, $2
       FROM articles a WHERE a.id = $1`,
    [articleId, userId],
  );
}

export async function insertHistory(
  db: Db,
  entry: {
    articleId: string;
    userId: string;
    operation: ArticleOperation;
    version: number;
    changes?: Record<string, unknown>;
    summary?: string;
    result?: 'success' | 'failure';
  },
): Promise<void> {
  await db.query(
    `INSERT INTO article_history (article_id, user_id, operation, version, changes, summary, result)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.articleId,
      entry.userId,
      entry.operation,
      entry.version,
      JSON.stringify(entry.changes ?? {}),
      entry.summary ?? null,
      entry.result ?? 'success',
    ],
  );
}

async function nameOf(table: 'categories' | 'systems', id: string | null, db: Db): Promise<string | null> {
  if (!id) return null;
  return (await queryOne<{ name: string }>(`SELECT name FROM ${table} WHERE id = $1`, [id], db))?.name ?? null;
}

/** Calcula as diferenças entre o estado atual e o novo (valores anteriores e posteriores). */
export async function diffArticle(
  current: ArticleRow,
  currentTags: string[],
  next: NormalizedArticle,
  db: Db,
): Promise<Record<string, { before: unknown; after: unknown }>> {
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  if (current.title !== next.title) changes.title = { before: current.title, after: next.title };
  if (current.summary !== next.summary) changes.summary = { before: current.summary, after: next.summary };
  if (current.content_html !== next.contentHtml) {
    changes.content = {
      before: { characters: current.content_text.length },
      after: { characters: next.contentText.length },
    };
  }
  if (current.category_id !== next.categoryId) {
    changes.category = { before: await nameOf('categories', current.category_id, db), after: await nameOf('categories', next.categoryId, db) };
  }
  if (current.system_id !== next.systemId) {
    changes.system = { before: await nameOf('systems', current.system_id, db), after: await nameOf('systems', next.systemId, db) };
  }
  if (JSON.stringify(current.keywords) !== JSON.stringify(next.keywords)) changes.keywords = { before: current.keywords, after: next.keywords };
  const sortedCurrent = [...currentTags].sort();
  const sortedNext = [...next.tagNames].sort();
  if (JSON.stringify(sortedCurrent) !== JSON.stringify(sortedNext)) changes.tags = { before: sortedCurrent, after: sortedNext };
  if (current.visibility !== next.visibility) changes.visibility = { before: current.visibility, after: next.visibility };
  return changes;
}

export const FIELD_LABELS: Record<string, string> = {
  title: 'título',
  summary: 'resumo',
  content: 'conteúdo',
  category: 'categoria',
  system: 'sistema',
  keywords: 'palavras-chave',
  tags: 'tags',
  visibility: 'visibilidade',
  status: 'status',
};

export function summarizeChanges(changes: Record<string, unknown>): string {
  const keys = Object.keys(changes);
  if (!keys.length) return 'Sem alterações de conteúdo';
  return `Alterou ${keys.map((k) => FIELD_LABELS[k] ?? k).join(', ')}`;
}

// ---------------------------------------------------------------------------
// Criação
// ---------------------------------------------------------------------------
export async function createArticle(user: AuthUser, input: ArticleInput, client: pg.PoolClient): Promise<ArticleRow> {
  if (user.userType !== 'internal' || !user.permissions.has('articles.create')) throw forbidden('Você não possui permissão para criar artigos.');
  if (input.visibility === 'internal' && !user.permissions.has('articles.view_internal')) {
    throw forbidden('Você não possui acesso a artigos internos.');
  }
  const n = await normalizeArticleInput(user, input, client);
  const slug = await uniqueSlug(n.title, client);
  const article = (await queryOne<ArticleRow>(
    `INSERT INTO articles (slug, title, summary, content_html, content_text, category_id, system_id, keywords, status, visibility, author_id, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9, $10, $10) RETURNING *`,
    [slug, n.title, n.summary, n.contentHtml, n.contentText, n.categoryId, n.systemId, n.keywords, n.visibility, user.id],
    client,
  ))!;
  await setTags(article.id, n.tagIds, client);
  await linkContentFiles(n.contentHtml, 'article', article.id, user.id, client);
  await insertVersionSnapshot(client, article.id, user.id);
  await insertHistory(client, {
    articleId: article.id,
    userId: user.id,
    operation: 'create',
    version: 1,
    changes: {
      title: { before: null, after: n.title },
      visibility: { before: null, after: n.visibility },
      status: { before: null, after: 'draft' },
    },
    summary: 'Artigo criado como rascunho',
  });
  await reindexArticle(client, article.id);
  return article;
}

export async function loadArticleForUpdate(client: pg.PoolClient, articleId: string): Promise<ArticleRow> {
  const a = await queryOne<ArticleRow>(`SELECT * FROM articles WHERE id = $1 FOR UPDATE`, [articleId], client);
  if (!a) throw notFound('Artigo não encontrado.');
  return a;
}

export function assertCanEdit(user: AuthUser, article: ArticleRow): void {
  const check = canEditArticle(user, article);
  if (!check.ok) {
    if (!canViewArticle(user, article)) throw notFound('Artigo não encontrado.');
    throw forbidden(check.reason);
  }
}

export function assertVersion(article: ArticleRow, expectedVersion: number): void {
  if (article.version !== expectedVersion) {
    throw conflict(
      'VERSION_CONFLICT',
      `O artigo foi alterado por outra sessão (versão atual ${article.version}, versão editada ${expectedVersion}). Recarregue o artigo para obter a versão mais recente antes de salvar.`,
      { currentVersion: article.version, expectedVersion },
    );
  }
}

// ---------------------------------------------------------------------------
// Atualização de conteúdo (com bloqueio validado pelo chamador)
// ---------------------------------------------------------------------------
export async function updateArticleContent(
  user: AuthUser,
  article: ArticleRow,
  input: ArticleInput,
  client: pg.PoolClient,
): Promise<{ article: ArticleRow; changed: boolean; changes: Record<string, unknown> }> {
  if (input.visibility === 'internal' && !user.permissions.has('articles.view_internal')) {
    throw forbidden('Você não possui acesso a artigos internos.');
  }
  const n = await normalizeArticleInput(user, input, client);
  const currentTags = (await getArticleTags(article.id, client)).map((t) => t.name);
  const changes = await diffArticle(article, currentTags, n, client);
  if (!Object.keys(changes).length) return { article, changed: false, changes };

  if (article.status === 'published') {
    const errors = publicationErrors({
      title: n.title,
      summary: n.summary,
      content_text: n.contentText,
      category_id: n.categoryId,
      system_id: n.systemId,
      keywords: n.keywords,
      visibility: n.visibility,
    });
    if (Object.keys(errors).length) {
      throw validationError('O artigo está publicado e os campos obrigatórios não podem ficar vazios.', { fields: errors });
    }
  }

  const updated = (await queryOne<ArticleRow>(
    `UPDATE articles SET title = $2, summary = $3, content_html = $4, content_text = $5, category_id = $6, system_id = $7,
            keywords = $8, visibility = $9, updated_by = $10, updated_at = now(), version = version + 1
      WHERE id = $1 RETURNING *`,
    [article.id, n.title, n.summary, n.contentHtml, n.contentText, n.categoryId, n.systemId, n.keywords, n.visibility, user.id],
    client,
  ))!;
  await setTags(article.id, n.tagIds, client);
  await linkContentFiles(n.contentHtml, 'article', article.id, user.id, client);
  await insertVersionSnapshot(client, article.id, user.id);
  await insertHistory(client, {
    articleId: article.id,
    userId: user.id,
    operation: 'update',
    version: updated.version,
    changes,
    summary: summarizeChanges(changes),
  });
  if (changes.visibility) {
    await insertHistory(client, {
      articleId: article.id,
      userId: user.id,
      operation: 'visibility_change',
      version: updated.version,
      changes: { visibility: changes.visibility },
      summary: `Visibilidade alterada de ${changes.visibility.before === 'internal' ? 'interno' : 'externo'} para ${changes.visibility.after === 'internal' ? 'interno' : 'externo'}`,
    });
  }
  await reindexArticle(client, article.id);
  return { article: updated, changed: true, changes };
}

// ---------------------------------------------------------------------------
// Alterações de status
// ---------------------------------------------------------------------------
type StatusAction = 'publish' | 'unpublish' | 'archive' | 'unarchive';

const STATUS_RULES: Record<StatusAction, { from: string[]; to: ArticleRow['status']; permission: string; operation: ArticleOperation; label: string }> = {
  publish: { from: ['draft', 'unpublished'], to: 'published', permission: 'articles.publish', operation: 'publish', label: 'Artigo publicado' },
  unpublish: { from: ['published'], to: 'unpublished', permission: 'articles.unpublish', operation: 'unpublish', label: 'Artigo despublicado' },
  archive: { from: ['draft', 'published', 'unpublished'], to: 'archived', permission: 'articles.archive', operation: 'archive', label: 'Artigo arquivado' },
  unarchive: { from: ['archived'], to: 'draft', permission: 'articles.archive', operation: 'unarchive', label: 'Artigo restaurado do arquivo como rascunho' },
};

export async function changeArticleStatus(
  user: AuthUser,
  article: ArticleRow,
  action: StatusAction,
  client: pg.PoolClient,
): Promise<ArticleRow> {
  const rule = STATUS_RULES[action];
  if (user.userType !== 'internal' || !user.permissions.has(rule.permission as never)) {
    if (!canViewArticle(user, article)) throw notFound('Artigo não encontrado.');
    throw forbidden('Você não possui permissão para esta operação.');
  }
  if (article.visibility === 'internal' && !user.permissions.has('articles.view_internal')) throw notFound('Artigo não encontrado.');
  if (!rule.from.includes(article.status)) {
    throw conflict('INVALID_STATUS', `Operação não permitida para artigos com status "${article.status}".`);
  }
  if (action === 'publish') {
    const errors = publicationErrors(article);
    if (Object.keys(errors).length) {
      throw validationError('Preencha os campos obrigatórios antes de publicar.', { fields: errors });
    }
  }
  const updated = (await queryOne<ArticleRow>(
    `UPDATE articles SET status = $2, version = version + 1, updated_at = now(), updated_by = $3,
            published_at = CASE WHEN $2 = 'published' THEN now() ELSE published_at END,
            published_by = CASE WHEN $2 = 'published' THEN $3 ELSE published_by END
      WHERE id = $1 RETURNING *`,
    [article.id, rule.to, user.id],
    client,
  ))!;
  await insertVersionSnapshot(client, article.id, user.id);
  await insertHistory(client, {
    articleId: article.id,
    userId: user.id,
    operation: rule.operation,
    version: updated.version,
    changes: { status: { before: article.status, after: rule.to } },
    summary: rule.label,
  });
  await reindexArticle(client, article.id);
  return updated;
}

// ---------------------------------------------------------------------------
// Restauração de versão: cria uma NOVA versão; o histórico anterior é preservado.
// ---------------------------------------------------------------------------
export async function restoreVersion(user: AuthUser, article: ArticleRow, version: number, client: pg.PoolClient): Promise<ArticleRow> {
  assertCanEdit(user, article);
  const snap = await queryOne<{
    title: string;
    summary: string;
    content_html: string;
    content_text: string;
    category_id: string | null;
    system_id: string | null;
    keywords: string[];
    tags: string[];
    visibility: 'internal' | 'external';
  }>(`SELECT * FROM article_versions WHERE article_id = $1 AND version = $2`, [article.id, version], client);
  if (!snap) throw notFound('Versão não encontrada.');

  const input: ArticleInput = {
    title: snap.title,
    summary: snap.summary,
    contentHtml: snap.content_html,
    categoryId: snap.category_id && (await queryOne(`SELECT 1 FROM categories WHERE id = $1`, [snap.category_id], client)) ? snap.category_id : null,
    systemId: snap.system_id && (await queryOne(`SELECT 1 FROM systems WHERE id = $1`, [snap.system_id], client)) ? snap.system_id : null,
    keywords: snap.keywords,
    tags: snap.tags,
    visibility: snap.visibility,
  };
  // Tags removidas do cadastro não são recriadas sem permissão.
  const existingTags = await query<{ name: string }>(`SELECT name FROM tags WHERE name = ANY($1::text[])`, [snap.tags], client);
  input.tags = user.permissions.has('categories.manage') ? snap.tags : existingTags.map((t) => t.name);

  const n = await normalizeArticleInput(user, input, client);
  const currentTags = (await getArticleTags(article.id, client)).map((t) => t.name);
  const changes = await diffArticle(article, currentTags, n, client);
  if (article.status === 'published') {
    const errors = publicationErrors({ ...article, title: n.title, summary: n.summary, content_text: n.contentText, category_id: n.categoryId, system_id: n.systemId, keywords: n.keywords });
    if (Object.keys(errors).length) throw validationError('A versão selecionada não possui os campos obrigatórios para um artigo publicado.', { fields: errors });
  }
  const updated = (await queryOne<ArticleRow>(
    `UPDATE articles SET title = $2, summary = $3, content_html = $4, content_text = $5, category_id = $6, system_id = $7,
            keywords = $8, visibility = $9, updated_by = $10, updated_at = now(), version = version + 1
      WHERE id = $1 RETURNING *`,
    [article.id, n.title, n.summary, n.contentHtml, n.contentText, n.categoryId, n.systemId, n.keywords, n.visibility, user.id],
    client,
  ))!;
  await setTags(article.id, n.tagIds, client);
  await insertVersionSnapshot(client, article.id, user.id);
  await insertHistory(client, {
    articleId: article.id,
    userId: user.id,
    operation: 'restore_version',
    version: updated.version,
    changes: { ...changes, restoredFrom: { before: article.version, after: version } },
    summary: `Conteúdo da versão ${version} restaurado como versão ${updated.version}`,
  });
  if (changes.visibility) {
    await insertHistory(client, {
      articleId: article.id,
      userId: user.id,
      operation: 'visibility_change',
      version: updated.version,
      changes: { visibility: changes.visibility },
      summary: 'Visibilidade alterada pela restauração de versão',
    });
  }
  await reindexArticle(client, article.id);
  return updated;
}

// ---------------------------------------------------------------------------
// Serialização
// ---------------------------------------------------------------------------
export async function serializeArticle(a: ArticleRow, db: Db = getPool()) {
  const extra = await queryOne<{
    category_name: string | null;
    category_slug: string | null;
    system_name: string | null;
    author_name: string;
    publisher_name: string | null;
    updater_name: string | null;
  }>(
    `SELECT c.name AS category_name, c.slug AS category_slug, s.name AS system_name, au.name AS author_name,
            pu.name AS publisher_name, uu.name AS updater_name
       FROM articles a
       LEFT JOIN categories c ON c.id = a.category_id
       LEFT JOIN systems s ON s.id = a.system_id
       JOIN users au ON au.id = a.author_id
       LEFT JOIN users pu ON pu.id = a.published_by
       LEFT JOIN users uu ON uu.id = a.updated_by
      WHERE a.id = $1`,
    [a.id],
    db,
  );
  const tags = await getArticleTags(a.id, db);
  return {
    id: a.id,
    slug: a.slug,
    title: a.title,
    summary: a.summary,
    contentHtml: a.content_html,
    category: a.category_id ? { id: a.category_id, name: extra?.category_name, slug: extra?.category_slug } : null,
    system: a.system_id ? { id: a.system_id, name: extra?.system_name } : null,
    keywords: a.keywords,
    tags,
    status: a.status,
    visibility: a.visibility,
    author: { id: a.author_id, name: extra?.author_name },
    updatedBy: a.updated_by ? { id: a.updated_by, name: extra?.updater_name } : null,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
    publishedAt: a.published_at,
    publishedBy: a.published_by ? { id: a.published_by, name: extra?.publisher_name } : null,
    version: a.version,
    viewCount: Number(a.view_count),
  };
}
