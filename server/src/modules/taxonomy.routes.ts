import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, queryOne } from '../db/pool.js';
import { requirePermission } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { conflict, notFound } from '../lib/errors.js';
import { slugify, cleanKeywords } from '../lib/text.js';
import { parse, uuid } from '../lib/validate.js';

function isFkViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23503';
}
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505';
}

const categorySchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome.').max(80),
  description: z.string().trim().max(300).optional().nullable(),
  icon: z.string().trim().max(40).optional().nullable(),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});
const systemSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome.').max(80),
  description: z.string().trim().max(300).optional().nullable(),
  active: z.boolean().default(true),
});
const tagSchema = z.object({ name: z.string().trim().min(2, 'Informe o nome.').max(60) });
const synonymSchema = z.object({
  term: z.string().trim().min(2).max(60),
  synonyms: z.array(z.string().max(60)).min(1, 'Informe pelo menos um sinônimo.').max(20),
});

export default async function taxonomyRoutes(app: FastifyInstance): Promise<void> {
  // Listagens públicas (necessárias para filtros e formulários).
  app.get('/api/taxonomy', async () => {
    const [categories, systems, tags] = await Promise.all([
      query(`SELECT id, name, slug, description, icon, sort_order AS "sortOrder" FROM categories ORDER BY sort_order, name`),
      query(`SELECT id, name, slug, description, active FROM systems ORDER BY name`),
      query(`SELECT id, name, slug FROM tags ORDER BY name`),
    ]);
    return { categories, systems, tags };
  });

  // ---- Categorias --------------------------------------------------------
  app.post('/api/categories', async (req, reply) => {
    const user = requirePermission(req, 'categories.manage');
    const body = parse(categorySchema, req.body);
    try {
      const row = await queryOne(
        `INSERT INTO categories (name, slug, description, icon, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [body.name, slugify(body.name), body.description ?? null, body.icon ?? null, body.sortOrder],
      );
      await audit({ actorId: user.id, action: 'category.create', entityType: 'category', entityId: row!.id, data: body, ip: req.ip });
      reply.code(201);
      return { category: row };
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('DUPLICATE', 'Já existe uma categoria com este nome.');
      throw err;
    }
  });

  app.put('/api/categories/:id', async (req) => {
    const user = requirePermission(req, 'categories.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(categorySchema, req.body);
    const before = await queryOne(`SELECT * FROM categories WHERE id = $1`, [id]);
    if (!before) throw notFound('Categoria não encontrada.');
    try {
      const row = await queryOne(
        `UPDATE categories SET name = $2, slug = $3, description = $4, icon = $5, sort_order = $6 WHERE id = $1 RETURNING *`,
        [id, body.name, slugify(body.name), body.description ?? null, body.icon ?? null, body.sortOrder],
      );
      // Atualiza o índice de pesquisa dos artigos da categoria.
      await query(`SELECT article_refresh_search_vector(id) FROM articles WHERE category_id = $1`, [id]);
      await audit({ actorId: user.id, action: 'category.update', entityType: 'category', entityId: id, data: { before, after: row }, ip: req.ip });
      return { category: row };
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('DUPLICATE', 'Já existe uma categoria com este nome.');
      throw err;
    }
  });

  app.delete('/api/categories/:id', async (req) => {
    const user = requirePermission(req, 'categories.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    try {
      const row = await queryOne(`DELETE FROM categories WHERE id = $1 RETURNING *`, [id]);
      if (!row) throw notFound('Categoria não encontrada.');
      await audit({ actorId: user.id, action: 'category.delete', entityType: 'category', entityId: id, data: { name: row.name }, ip: req.ip });
      return { ok: true };
    } catch (err) {
      if (isFkViolation(err)) throw conflict('IN_USE', 'A categoria está em uso por artigos, documentos ou tickets e não pode ser excluída.');
      throw err;
    }
  });

  // ---- Sistemas ----------------------------------------------------------
  app.post('/api/systems', async (req, reply) => {
    const user = requirePermission(req, 'categories.manage');
    const body = parse(systemSchema, req.body);
    try {
      const row = await queryOne(`INSERT INTO systems (name, slug, description, active) VALUES ($1, $2, $3, $4) RETURNING *`, [
        body.name,
        slugify(body.name),
        body.description ?? null,
        body.active,
      ]);
      await audit({ actorId: user.id, action: 'system.create', entityType: 'system', entityId: row!.id, data: body, ip: req.ip });
      reply.code(201);
      return { system: row };
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('DUPLICATE', 'Já existe um sistema com este nome.');
      throw err;
    }
  });

  app.put('/api/systems/:id', async (req) => {
    const user = requirePermission(req, 'categories.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(systemSchema, req.body);
    try {
      const row = await queryOne(`UPDATE systems SET name = $2, slug = $3, description = $4, active = $5 WHERE id = $1 RETURNING *`, [
        id,
        body.name,
        slugify(body.name),
        body.description ?? null,
        body.active,
      ]);
      if (!row) throw notFound('Sistema não encontrado.');
      await query(`SELECT article_refresh_search_vector(id) FROM articles WHERE system_id = $1`, [id]);
      await audit({ actorId: user.id, action: 'system.update', entityType: 'system', entityId: id, data: body, ip: req.ip });
      return { system: row };
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('DUPLICATE', 'Já existe um sistema com este nome.');
      throw err;
    }
  });

  app.delete('/api/systems/:id', async (req) => {
    const user = requirePermission(req, 'categories.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    try {
      const row = await queryOne(`DELETE FROM systems WHERE id = $1 RETURNING *`, [id]);
      if (!row) throw notFound('Sistema não encontrado.');
      await audit({ actorId: user.id, action: 'system.delete', entityType: 'system', entityId: id, data: { name: row.name }, ip: req.ip });
      return { ok: true };
    } catch (err) {
      if (isFkViolation(err)) throw conflict('IN_USE', 'O sistema está em uso e não pode ser excluído. Desative-o.');
      throw err;
    }
  });

  // ---- Tags --------------------------------------------------------------
  app.post('/api/tags', async (req, reply) => {
    const user = requirePermission(req, 'categories.manage');
    const body = parse(tagSchema, req.body);
    try {
      const row = await queryOne(`INSERT INTO tags (name, slug) VALUES ($1, $2) RETURNING *`, [body.name, slugify(body.name, 60)]);
      await audit({ actorId: user.id, action: 'tag.create', entityType: 'tag', entityId: row!.id, data: body, ip: req.ip });
      reply.code(201);
      return { tag: row };
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('DUPLICATE', 'Já existe uma tag com este nome.');
      throw err;
    }
  });

  app.delete('/api/tags/:id', async (req) => {
    const user = requirePermission(req, 'categories.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    try {
      const row = await queryOne(`DELETE FROM tags WHERE id = $1 RETURNING *`, [id]);
      if (!row) throw notFound('Tag não encontrada.');
      await audit({ actorId: user.id, action: 'tag.delete', entityType: 'tag', entityId: id, data: { name: row.name }, ip: req.ip });
      return { ok: true };
    } catch (err) {
      if (isFkViolation(err)) throw conflict('IN_USE', 'A tag está em uso por artigos e não pode ser excluída.');
      throw err;
    }
  });

  // ---- Sinônimos de pesquisa --------------------------------------------
  app.get('/api/search-synonyms', async (req) => {
    requirePermission(req, 'categories.manage');
    return { items: await query(`SELECT id, term, synonyms FROM search_synonyms ORDER BY term`) };
  });

  app.post('/api/search-synonyms', async (req, reply) => {
    const user = requirePermission(req, 'categories.manage');
    const body = parse(synonymSchema, req.body);
    try {
      const row = await queryOne(`INSERT INTO search_synonyms (term, synonyms) VALUES ($1, $2) RETURNING id, term, synonyms`, [
        body.term,
        cleanKeywords(body.synonyms),
      ]);
      await audit({ actorId: user.id, action: 'synonym.create', entityType: 'search_synonym', entityId: row!.id, data: body, ip: req.ip });
      reply.code(201);
      return { item: row };
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('DUPLICATE', 'Este termo já possui sinônimos cadastrados.');
      throw err;
    }
  });

  app.delete('/api/search-synonyms/:id', async (req) => {
    const user = requirePermission(req, 'categories.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const row = await queryOne(`DELETE FROM search_synonyms WHERE id = $1 RETURNING term`, [id]);
    if (!row) throw notFound();
    await audit({ actorId: user.id, action: 'synonym.delete', entityType: 'search_synonym', entityId: id, data: row, ip: req.ip });
    return { ok: true };
  });
}
