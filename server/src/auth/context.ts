import type { FastifyRequest } from 'fastify';
import { computeEffectivePermissions, type PermissionKey, type UserType } from '@shared/permissions.js';
import { type Db, getPool, query, queryOne } from '../db/pool.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  userType: UserType;
  companyId: string | null;
  companyName: string | null;
  /** Empresa principal + empresas extras com acesso concedido. */
  companyIds: string[];
  roles: string[];
  permissions: Set<PermissionKey>;
  sessionId: string;
  csrfToken: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthUser | null;
  }
}

/** Carrega as permissões efetivas do usuário diretamente do banco (sem cache). */
export async function loadUserPermissions(
  userId: string,
  userType: UserType,
  db: Db = getPool(),
): Promise<{ roles: string[]; permissions: PermissionKey[] }> {
  const roleRows = await query<{ key: string; permission_key: string | null }>(
    `SELECT r.key, rp.permission_key
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
      WHERE ur.user_id = $1`,
    [userId],
    db,
  );
  const overrides = await query<{ permission_key: string; effect: 'grant' | 'deny' }>(
    `SELECT permission_key, effect FROM user_permissions WHERE user_id = $1`,
    [userId],
    db,
  );
  const roles = [...new Set(roleRows.map((r) => r.key))];
  const rolePerms = roleRows.map((r) => r.permission_key).filter((p): p is string => !!p);
  const grants = overrides.filter((o) => o.effect === 'grant').map((o) => o.permission_key);
  const denies = overrides.filter((o) => o.effect === 'deny').map((o) => o.permission_key);
  return { roles, permissions: computeEffectivePermissions(userType, rolePerms, grants, denies) };
}

export interface SessionUserRow {
  session_id: string;
  csrf_token: string;
  last_seen_at: Date;
  user_id: string;
  name: string;
  email: string;
  user_type: UserType;
  company_id: string | null;
  company_name: string | null;
  extra_company_ids: string[];
}

export async function findSessionUser(tokenHash: string): Promise<SessionUserRow | null> {
  return queryOne<SessionUserRow>(
    `SELECT s.id AS session_id, s.csrf_token, s.last_seen_at, u.id AS user_id, u.name, u.email, u.user_type,
            u.company_id, c.name AS company_name,
            coalesce((SELECT array_agg(a.company_id) FROM user_company_access a WHERE a.user_id = u.id), '{}') AS extra_company_ids
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN companies c ON c.id = u.company_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active = true`,
    [tokenHash],
  );
}

export function hasPermission(user: AuthUser | null, perm: PermissionKey): boolean {
  return !!user && user.permissions.has(perm);
}

export function isInternal(user: AuthUser | null): user is AuthUser {
  return !!user && user.userType === 'internal';
}

export function requireAuth(req: FastifyRequest): AuthUser {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export function requireInternal(req: FastifyRequest): AuthUser {
  const user = requireAuth(req);
  if (user.userType !== 'internal') throw forbidden('Área disponível somente para usuários internos.');
  return user;
}

export function requirePermission(req: FastifyRequest, ...perms: PermissionKey[]): AuthUser {
  const user = requireAuth(req);
  for (const p of perms) {
    if (!user.permissions.has(p)) throw forbidden();
  }
  return user;
}

export function requireAnyPermission(req: FastifyRequest, ...perms: PermissionKey[]): AuthUser {
  const user = requireAuth(req);
  if (!perms.some((p) => user.permissions.has(p))) throw forbidden();
  return user;
}

/** Público de conteúdo do usuário: quais visibilidades ele pode consultar. */
export function allowedVisibilities(user: AuthUser | null): Array<'internal' | 'external'> {
  if (isInternal(user) && user.permissions.has('articles.view_internal')) return ['internal', 'external'];
  return ['external'];
}

export function clientIp(req: FastifyRequest): string {
  return req.ip;
}
