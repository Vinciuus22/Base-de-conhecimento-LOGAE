import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSION_DEFINITIONS, ROLE_DEFINITIONS, isPermissionKey } from '@shared/permissions.js';
import { query, queryOne, withTransaction } from '../db/pool.js';
import { loadUserPermissions, requirePermission } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { hashPassword, randomToken, validatePasswordStrength } from '../lib/crypto.js';
import { conflict, notFound, validationError, forbidden } from '../lib/errors.js';
import { pageQuery, parse, uuid } from '../lib/validate.js';

const companySchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome da empresa.').max(150),
  document: z.string().trim().max(30).optional().nullable(),
  active: z.boolean().default(true),
});

const userCreateSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome.').max(150),
  email: z.string().trim().email('E-mail inválido.').max(200),
  userType: z.enum(['internal', 'external']),
  companyId: z.string().uuid().nullable().optional(),
  roles: z.array(z.string()).max(10).default([]),
  password: z.string().max(200).optional(),
});

const userUpdateSchema = z.object({
  name: z.string().trim().min(2).max(150),
  companyId: z.string().uuid().nullable().optional(),
  active: z.boolean(),
});

async function userDetail(id: string) {
  const u = await queryOne<{
    id: string; name: string; email: string; user_type: 'internal' | 'external'; company_id: string | null; company_name: string | null;
    active: boolean; created_at: Date; last_login_at: Date | null; anonymized_at: Date | null;
  }>(
    `SELECT u.id, u.name, u.email, u.user_type, u.company_id, c.name AS company_name, u.active, u.created_at, u.last_login_at, u.anonymized_at
       FROM users u LEFT JOIN companies c ON c.id = u.company_id WHERE u.id = $1`,
    [id],
  );
  if (!u) return null;
  const overrides = await query<{ permission_key: string; effect: string; granted_at: Date; granted_by_name: string | null }>(
    `SELECT up.permission_key, up.effect, up.granted_at, g.name AS granted_by_name
       FROM user_permissions up LEFT JOIN users g ON g.id = up.granted_by WHERE up.user_id = $1`,
    [id],
  );
  const { roles, permissions } = await loadUserPermissions(u.id, u.user_type);
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    userType: u.user_type,
    company: u.company_id ? { id: u.company_id, name: u.company_name } : null,
    active: u.active,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
    anonymizedAt: u.anonymized_at,
    roles,
    effectivePermissions: permissions,
    overrides: overrides.map((o) => ({ permission: o.permission_key, effect: o.effect, grantedAt: o.granted_at, grantedBy: o.granted_by_name })),
  };
}

export default async function userRoutes(app: FastifyInstance): Promise<void> {
  // ---- Catálogo ---------------------------------------------------------
  app.get('/api/admin/permissions', async (req) => {
    requirePermission(req, 'users.manage');
    return { permissions: PERMISSION_DEFINITIONS, roles: ROLE_DEFINITIONS };
  });

  // ---- Empresas ---------------------------------------------------------
  app.get('/api/companies', async (req) => {
    requirePermission(req, 'users.manage');
    return {
      items: await query(
        `SELECT c.id, c.name, c.document, c.active, c.created_at AS "createdAt",
                (SELECT count(*) FROM users u WHERE u.company_id = c.id)::int AS "userCount"
           FROM companies c ORDER BY c.name`,
      ),
    };
  });

  app.post('/api/companies', async (req, reply) => {
    const user = requirePermission(req, 'users.manage');
    const body = parse(companySchema, req.body);
    try {
      const row = await queryOne(`INSERT INTO companies (name, document, active) VALUES ($1, $2, $3) RETURNING *`, [body.name, body.document ?? null, body.active]);
      await audit({ actorId: user.id, action: 'company.create', entityType: 'company', entityId: row!.id, data: body, ip: req.ip });
      reply.code(201);
      return { company: row };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict('DUPLICATE', 'Já existe uma empresa com este nome.');
      throw err;
    }
  });

  app.put('/api/companies/:id', async (req) => {
    const user = requirePermission(req, 'users.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(companySchema, req.body);
    const row = await queryOne(`UPDATE companies SET name = $2, document = $3, active = $4, updated_at = now() WHERE id = $1 RETURNING *`, [
      id,
      body.name,
      body.document ?? null,
      body.active,
    ]);
    if (!row) throw notFound('Empresa não encontrada.');
    await audit({ actorId: user.id, action: 'company.update', entityType: 'company', entityId: id, data: body, ip: req.ip });
    return { company: row };
  });

  // ---- Usuários ---------------------------------------------------------
  app.get('/api/users', async (req) => {
    requirePermission(req, 'users.manage');
    const q = parse(z.object({ q: z.string().max(100).optional(), userType: z.enum(['internal', 'external']).optional() }).merge(pageQuery), req.query);
    const rows = await query(
      `SELECT u.id, u.name, u.email, u.user_type, u.active, u.last_login_at, c.name AS company_name,
              coalesce((SELECT array_agg(r.name ORDER BY r.name) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id), '{}') AS roles,
              count(*) OVER () AS total
         FROM users u LEFT JOIN companies c ON c.id = u.company_id
        WHERE ($1::text IS NULL OR immutable_unaccent(lower(u.name || ' ' || u.email)) LIKE '%' || immutable_unaccent(lower($1)) || '%')
          AND ($2::text IS NULL OR u.user_type = $2)
        ORDER BY u.name LIMIT $3 OFFSET $4`,
      [q.q ?? null, q.userType ?? null, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return {
      total: rows.length ? Number(rows[0]!.total) : 0,
      items: rows.map((r) => ({
        id: r.id, name: r.name, email: r.email, userType: r.user_type, active: r.active, lastLoginAt: r.last_login_at,
        company: r.company_name, roles: r.roles,
      })),
    };
  });

  // Lista de atendentes (para atribuição de tickets).
  app.get('/api/users/agents', async (req) => {
    requirePermission(req, 'tickets.manage');
    const rows = await query<{ id: string; name: string; user_type: 'internal' | 'external' }>(
      `SELECT id, name, user_type FROM users WHERE active AND user_type = 'internal' ORDER BY name`,
    );
    const agents = [];
    for (const r of rows) {
      const { permissions } = await loadUserPermissions(r.id, r.user_type);
      if (permissions.includes('tickets.support') || permissions.includes('tickets.manage')) agents.push({ id: r.id, name: r.name });
    }
    return { items: agents };
  });

  app.get('/api/users/:id', async (req) => {
    requirePermission(req, 'users.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const user = await userDetail(id);
    if (!user) throw notFound('Usuário não encontrado.');
    return { user };
  });

  app.post('/api/users', async (req, reply) => {
    const admin = requirePermission(req, 'users.manage');
    const body = parse(userCreateSchema, req.body);
    if (body.userType === 'external' && !body.companyId) {
      throw validationError('Usuários externos devem estar vinculados a uma empresa.', { fields: { companyId: 'Selecione a empresa.' } });
    }
    let password = body.password;
    let generated = false;
    if (!password) {
      password = `${randomToken(9)}9a`;
      generated = true;
    }
    const weak = validatePasswordStrength(password);
    if (weak) throw validationError(weak, { fields: { password: weak } });

    const created = await withTransaction(async (client) => {
      const exists = await queryOne(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [body.email], client);
      if (exists) throw conflict('DUPLICATE', 'Já existe um usuário com este e-mail.');
      const u = await queryOne<{ id: string }>(
        `INSERT INTO users (name, email, password_hash, user_type, company_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [body.name, body.email, await hashPassword(password!), body.userType, body.companyId ?? null],
        client,
      );
      for (const roleKey of body.roles) {
        const role = await queryOne<{ id: string; user_type: string }>(`SELECT id, user_type FROM roles WHERE key = $1`, [roleKey], client);
        if (!role) throw validationError(`Perfil inválido: ${roleKey}`);
        if (role.user_type !== body.userType) throw validationError(`O perfil "${roleKey}" não é compatível com o tipo de usuário.`);
        await client.query(`INSERT INTO user_roles (user_id, role_id, granted_by) VALUES ($1, $2, $3)`, [u!.id, role.id, admin.id]);
      }
      return u!;
    });
    await audit({ actorId: admin.id, action: 'user.create', entityType: 'user', entityId: created.id, data: { name: body.name, email: body.email, userType: body.userType, roles: body.roles }, ip: req.ip });
    reply.code(201);
    // A senha gerada é exibida UMA única vez ao administrador e nunca registrada em logs.
    return { user: await userDetail(created.id), temporaryPassword: generated ? password : undefined };
  });

  app.put('/api/users/:id', async (req) => {
    const admin = requirePermission(req, 'users.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(userUpdateSchema, req.body);
    if (id === admin.id && !body.active) throw validationError('Você não pode desativar o próprio usuário.');
    const before = await userDetail(id);
    if (!before) throw notFound('Usuário não encontrado.');
    if (before.userType === 'external' && !body.companyId) throw validationError('Usuários externos devem estar vinculados a uma empresa.');
    await query(`UPDATE users SET name = $2, company_id = $3, active = $4, updated_at = now() WHERE id = $1`, [id, body.name, body.companyId ?? null, body.active]);
    if (!body.active) {
      await query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
      await query(`DELETE FROM article_locks WHERE user_id = $1`, [id]);
    }
    await audit({ actorId: admin.id, action: 'user.update', entityType: 'user', entityId: id, data: { before: { name: before.name, company: before.company, active: before.active }, after: body }, ip: req.ip });
    return { user: await userDetail(id) };
  });

  app.post('/api/users/:id/reset-password', async (req) => {
    const admin = requirePermission(req, 'users.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const temp = `${randomToken(9)}7b`;
    const row = await queryOne(`UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1 RETURNING id`, [
      id,
      await hashPassword(temp),
    ]);
    if (!row) throw notFound('Usuário não encontrado.');
    await query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
    await audit({ actorId: admin.id, action: 'user.password_reset', entityType: 'user', entityId: id, ip: req.ip });
    return { temporaryPassword: temp };
  });

  // Perfis: substitui o conjunto de perfis do usuário (registrando cada concessão/revogação).
  app.put('/api/users/:id/roles', async (req) => {
    const admin = requirePermission(req, 'users.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { roles } = parse(z.object({ roles: z.array(z.string()).max(10) }), req.body);
    const target = await queryOne<{ user_type: string }>(`SELECT user_type FROM users WHERE id = $1`, [id]);
    if (!target) throw notFound('Usuário não encontrado.');
    if (id === admin.id && !roles.includes('admin')) {
      const stillManages = (await queryOne(`SELECT 1 FROM user_permissions WHERE user_id = $1 AND permission_key = 'users.manage' AND effect = 'grant'`, [id]));
      if (!stillManages) throw forbidden('Você não pode remover o próprio perfil de administrador.');
    }
    await withTransaction(async (client) => {
      const current = await query<{ key: string; id: string }>(`SELECT r.key, r.id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`, [id], client);
      const currentKeys = current.map((c) => c.key);
      for (const key of roles.filter((r) => !currentKeys.includes(r))) {
        const role = await queryOne<{ id: string; user_type: string }>(`SELECT id, user_type FROM roles WHERE key = $1`, [key], client);
        if (!role) throw validationError(`Perfil inválido: ${key}`);
        if (role.user_type !== target.user_type) throw validationError(`O perfil "${key}" não é compatível com o tipo de usuário.`);
        await client.query(`INSERT INTO user_roles (user_id, role_id, granted_by) VALUES ($1, $2, $3)`, [id, role.id, admin.id]);
        await audit({ actorId: admin.id, action: 'role.granted', entityType: 'user', entityId: id, data: { role: key }, ip: req.ip }, client);
      }
      for (const c of current.filter((c) => !roles.includes(c.key))) {
        await client.query(`DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2`, [id, c.id]);
        await audit({ actorId: admin.id, action: 'role.revoked', entityType: 'user', entityId: id, data: { role: c.key }, ip: req.ip }, client);
      }
    });
    return { user: await userDetail(id) };
  });

  // Permissões individuais: concede ('grant'), revoga ('deny') ou remove a exceção ('inherit').
  app.put('/api/users/:id/permissions/:permission', async (req) => {
    const admin = requirePermission(req, 'users.manage');
    const { id, permission } = parse(z.object({ id: uuid, permission: z.string() }), req.params);
    const { effect } = parse(z.object({ effect: z.enum(['grant', 'deny', 'inherit']) }), req.body);
    if (!isPermissionKey(permission)) throw validationError('Permissão inválida.');
    const target = await queryOne<{ user_type: string }>(`SELECT user_type FROM users WHERE id = $1`, [id]);
    if (!target) throw notFound('Usuário não encontrado.');
    const def = PERMISSION_DEFINITIONS.find((p) => p.key === permission)!;
    if (effect === 'grant' && def.internalOnly && target.user_type !== 'internal') {
      throw validationError('Esta permissão é exclusiva de usuários internos e não pode ser concedida a usuários externos.');
    }
    if (id === admin.id && permission === 'users.manage' && effect === 'deny') {
      throw forbidden('Você não pode revogar a própria permissão de gerenciar usuários.');
    }
    const before = await queryOne<{ effect: string }>(`SELECT effect FROM user_permissions WHERE user_id = $1 AND permission_key = $2`, [id, permission]);
    if (effect === 'inherit') {
      await query(`DELETE FROM user_permissions WHERE user_id = $1 AND permission_key = $2`, [id, permission]);
    } else {
      await query(
        `INSERT INTO user_permissions (user_id, permission_key, effect, granted_by, granted_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (user_id, permission_key) DO UPDATE SET effect = EXCLUDED.effect, granted_by = EXCLUDED.granted_by, granted_at = now()`,
        [id, permission, effect, admin.id],
      );
    }
    await audit({
      actorId: admin.id,
      action: effect === 'grant' ? 'permission.granted' : effect === 'deny' ? 'permission.revoked' : 'permission.reset',
      entityType: 'user',
      entityId: id,
      data: { permission, before: before?.effect ?? 'inherit', after: effect },
      ip: req.ip,
    });
    return { user: await userDetail(id) };
  });

  // LGPD: anonimização de dados pessoais preservando a integridade dos registros.
  app.post('/api/users/:id/anonymize', async (req) => {
    const admin = requirePermission(req, 'users.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    if (id === admin.id) throw validationError('Você não pode anonimizar o próprio usuário.');
    const { confirm } = parse(z.object({ confirm: z.literal('ANONIMIZAR', { errorMap: () => ({ message: 'Digite ANONIMIZAR para confirmar.' }) }) }), req.body);
    void confirm;
    const row = await queryOne(
      `UPDATE users SET name = 'Usuário anonimizado', email = 'anonimizado+' || id || '@invalid.local', password_hash = 'disabled',
              active = false, anonymized_at = now(), updated_at = now()
        WHERE id = $1 AND anonymized_at IS NULL RETURNING id`,
      [id],
    );
    if (!row) throw notFound('Usuário não encontrado ou já anonimizado.');
    await query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
    await query(`DELETE FROM article_locks WHERE user_id = $1`, [id]);
    await query(`DELETE FROM ai_conversations WHERE user_id = $1`, [id]);
    await audit({ actorId: admin.id, action: 'user.anonymized', entityType: 'user', entityId: id, ip: req.ip });
    return { ok: true };
  });
}
