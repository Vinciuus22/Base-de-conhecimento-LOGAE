import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { sha256Hex, safeEqual } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { findSessionUser, loadUserPermissions } from './context.js';

export const SESSION_COOKIE = 'kb_session';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Rotas que dispensam o cabeçalho CSRF (validadas por outro segredo). */
const CSRF_EXEMPT = [/^\/api\/auth\/login$/, /^\/api\/articles\/[^/]+\/lock\/beacon$/];

function originAllowed(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const allowed = new Set<string>();
  try {
    allowed.add(new URL(config().PUBLIC_BASE_URL).origin);
  } catch {
    /* ignora */
  }
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  if (host) {
    allowed.add(`${req.protocol}://${host}`);
  }
  return allowed.has(origin);
}

async function authPlugin(app: FastifyInstance): Promise<void> {
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (req: FastifyRequest, _reply: FastifyReply) => {
    req.auth = null;
    if (!req.url.startsWith('/api/')) return;

    if (UNSAFE_METHODS.has(req.method) && !originAllowed(req)) {
      throw new AppError(403, 'ORIGIN_NOT_ALLOWED', 'Origem da requisição não permitida.');
    }

    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const row = await findSessionUser(sha256Hex(token));
    if (!row) return;

    const { roles, permissions } = await loadUserPermissions(row.user_id, row.user_type);
    req.auth = {
      id: row.user_id,
      name: row.name,
      email: row.email,
      userType: row.user_type,
      companyId: row.company_id,
      companyName: row.company_name,
      companyIds: [...new Set([...(row.company_id ? [row.company_id] : []), ...row.extra_company_ids])],
      roles,
      permissions: new Set(permissions),
      sessionId: row.session_id,
      csrfToken: row.csrf_token,
    };

    // Proteção CSRF: requisições que alteram estado com sessão exigem o token.
    const path = req.url.split('?')[0]!;
    if (UNSAFE_METHODS.has(req.method) && !CSRF_EXEMPT.some((re) => re.test(path))) {
      const header = req.headers['x-csrf-token'];
      if (typeof header !== 'string' || !safeEqual(header, row.csrf_token)) {
        throw new AppError(403, 'CSRF_INVALID', 'Token de segurança inválido. Recarregue a página e tente novamente.');
      }
    }

    // Expiração deslizante (atualiza no máximo a cada 5 minutos).
    if (Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60_000) {
      await query(
        `UPDATE sessions SET last_seen_at = now(), expires_at = now() + ($2 || ' hours')::interval WHERE id = $1`,
        [row.session_id, String(config().SESSION_TTL_HOURS)],
      );
    }
  });
}

export default fp(authPlugin, { name: 'auth' });
