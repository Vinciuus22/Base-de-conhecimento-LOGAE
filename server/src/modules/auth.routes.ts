import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { query, queryOne } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { hashPassword, randomToken, sha256Hex, validatePasswordStrength, verifyPassword } from '../lib/crypto.js';
import { AppError, validationError } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { requireAuth, type AuthUser } from '../auth/context.js';
import { SESSION_COOKIE } from '../auth/plugin.js';

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;
// Hash fixo para equalizar o tempo de resposta quando o e-mail não existe.
let dummyHash: Promise<string> | null = null;

export function serializeMe(user: AuthUser) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    userType: user.userType,
    company: user.companyId ? { id: user.companyId, name: user.companyName } : null,
    roles: user.roles,
    permissions: [...user.permissions],
    csrfToken: user.csrfToken,
  };
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: config().RATE_LIMIT_LOGIN_PER_MIN, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = parse(
        z.object({ email: z.string().trim().email('Informe um e-mail válido.').max(200), password: z.string().min(1).max(200) }),
        req.body,
      );
      const user = await queryOne<{
        id: string;
        password_hash: string;
        active: boolean;
        failed_logins: number;
        locked_until: Date | null;
      }>(`SELECT id, password_hash, active, failed_logins, locked_until FROM users WHERE lower(email) = lower($1)`, [body.email]);

      const invalid = new AppError(401, 'INVALID_CREDENTIALS', 'E-mail ou senha inválidos.');
      if (!user) {
        dummyHash ??= hashPassword('senha-inexistente-123');
        await verifyPassword(body.password, await dummyHash);
        await audit({ actorId: null, action: 'auth.login_failed', data: { email: body.email, reason: 'unknown_user' }, ip: req.ip });
        throw invalid;
      }
      if (user.locked_until && user.locked_until > new Date()) {
        await audit({ actorId: user.id, action: 'auth.login_blocked', entityType: 'user', entityId: user.id, ip: req.ip });
        throw new AppError(429, 'ACCOUNT_LOCKED', 'Muitas tentativas inválidas. Aguarde alguns minutos e tente novamente.');
      }
      const ok = await verifyPassword(body.password, user.password_hash);
      if (!ok || !user.active) {
        const failed = user.failed_logins + 1;
        const lockAccount = failed >= MAX_FAILED_LOGINS;
        await query(
          `UPDATE users SET failed_logins = $2,
                  locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END
            WHERE id = $1`,
          [user.id, lockAccount ? 0 : failed, lockAccount, String(LOCKOUT_MINUTES)],
        );
        await audit({
          actorId: user.id,
          action: 'auth.login_failed',
          entityType: 'user',
          entityId: user.id,
          data: { reason: user.active ? 'bad_password' : 'inactive' },
          ip: req.ip,
        });
        throw invalid;
      }

      const token = randomToken(32);
      const csrf = randomToken(24);
      await query(
        `INSERT INTO sessions (token_hash, user_id, csrf_token, ip, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' hours')::interval)`,
        [sha256Hex(token), user.id, csrf, req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300), String(config().SESSION_TTL_HOURS)],
      );
      await query(`UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [user.id]);
      await audit({ actorId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id, ip: req.ip });

      reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config().COOKIE_SECURE,
        path: '/',
        maxAge: config().SESSION_TTL_HOURS * 3600,
      });
      return { ok: true, csrfToken: csrf };
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.auth) {
      await query(`DELETE FROM sessions WHERE id = $1`, [req.auth.sessionId]);
      // Libera bloqueios de edição mantidos por esta sessão.
      await query(`DELETE FROM article_locks WHERE session_id = $1`, [req.auth.sessionId]);
      await audit({ actorId: req.auth.id, action: 'auth.logout', entityType: 'user', entityId: req.auth.id, ip: req.ip });
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    if (!req.auth) return { user: null };
    return { user: serializeMe(req.auth) };
  });

  app.post('/api/auth/change-password', async (req) => {
    const user = requireAuth(req);
    const body = parse(z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1) }), req.body);
    const strength = validatePasswordStrength(body.newPassword);
    if (strength) throw validationError(strength, { fields: { newPassword: strength } });
    const row = await queryOne<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [user.id]);
    if (!row || !(await verifyPassword(body.currentPassword, row.password_hash))) {
      throw validationError('Senha atual incorreta.', { fields: { currentPassword: 'Senha atual incorreta.' } });
    }
    await query(`UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, [user.id, await hashPassword(body.newPassword)]);
    // Encerra as demais sessões do usuário.
    await query(`DELETE FROM sessions WHERE user_id = $1 AND id <> $2`, [user.id, user.sessionId]);
    await audit({ actorId: user.id, action: 'auth.password_changed', entityType: 'user', entityId: user.id, ip: req.ip });
    return { ok: true };
  });
}
