import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { config } from '../../config.js';
import { type Db, getPool, query, queryOne } from '../../db/pool.js';
import type { AuthUser } from '../../auth/context.js';
import { audit } from '../../lib/audit.js';
import { conflict } from '../../lib/errors.js';

/**
 * Bloqueio de edição simultânea (lease com expiração e renovação periódica).
 *
 * - A tabela article_locks tem o article_id como CHAVE PRIMÁRIA: existe no
 *   máximo um bloqueio por artigo.
 * - A aquisição é ATÔMICA: INSERT ... ON CONFLICT DO UPDATE ... WHERE o bloqueio
 *   existente já expirou. Se duas sessões tentarem ao mesmo tempo, o PostgreSQL
 *   serializa as operações na mesma linha e apenas uma obtém o RETURNING.
 * - Cada aquisição gera um lock_token secreto, exigido na renovação, no
 *   salvamento e na liberação. Uma sessão antiga (token anterior) nunca salva.
 */

export interface LockRow {
  article_id: string;
  user_id: string;
  session_id: string | null;
  lock_token: string;
  acquired_at: Date;
  renewed_at: Date;
  expires_at: Date;
}

export interface LockHolder {
  userId: string;
  userName: string;
  acquiredAt: Date;
  expiresAt: Date;
}

export async function getActiveLock(articleId: string, db: Db = getPool()): Promise<(LockRow & { user_name: string }) | null> {
  return queryOne<LockRow & { user_name: string }>(
    `SELECT l.*, u.name AS user_name FROM article_locks l JOIN users u ON u.id = l.user_id
      WHERE l.article_id = $1 AND l.expires_at > now()`,
    [articleId],
    db,
  );
}

export function lockConflict(holder: { user_name: string; acquired_at: Date; expires_at: Date; user_id: string }) {
  return conflict('ARTICLE_LOCKED', `Este artigo está sendo editado por ${holder.user_name}.`, {
    holder: { userId: holder.user_id, name: holder.user_name, acquiredAt: holder.acquired_at, expiresAt: holder.expires_at },
  });
}

/** Tenta adquirir o bloqueio. Retorna o bloqueio obtido ou lança 409 com o responsável atual. */
export async function acquireLock(user: AuthUser, articleId: string, ip?: string, attempt = 0): Promise<LockRow> {
  const ttl = config().LOCK_TTL_SECONDS;
  const token = randomUUID();
  const rows = await query<LockRow & { previous_user: string | null; previous_expires: Date | null }>(
    `WITH previous AS (
       SELECT user_id, expires_at FROM article_locks WHERE article_id = $1
     ), upsert AS (
       INSERT INTO article_locks (article_id, user_id, session_id, lock_token, acquired_at, renewed_at, expires_at)
       VALUES ($1, $2, $3, $4, now(), now(), now() + make_interval(secs => $5))
       ON CONFLICT (article_id) DO UPDATE
         SET user_id = EXCLUDED.user_id, session_id = EXCLUDED.session_id, lock_token = EXCLUDED.lock_token,
             acquired_at = now(), renewed_at = now(), expires_at = EXCLUDED.expires_at
         WHERE article_locks.expires_at <= now()
       RETURNING *
     )
     SELECT upsert.*, (SELECT user_id FROM previous) AS previous_user, (SELECT expires_at FROM previous) AS previous_expires
       FROM upsert`,
    [articleId, user.id, user.sessionId, token, ttl],
  );
  const lock = rows[0];
  if (!lock) {
    const holder = await getActiveLock(articleId);
    if (holder) throw lockConflict(holder);
    // O bloqueio expirou entre as duas consultas: tenta novamente uma única vez.
    if (attempt < 1) return acquireLock(user, articleId, ip, attempt + 1);
    throw conflict('ARTICLE_LOCKED', 'Não foi possível obter o bloqueio de edição. Tente novamente.');
  }
  if (lock.previous_user) {
    await audit({
      actorId: null,
      action: 'article.lock_expired',
      entityType: 'article',
      entityId: articleId,
      data: { previousUserId: lock.previous_user, expiredAt: lock.previous_expires, reason: 'Lease expirado sem renovação' },
    });
  }
  await audit({ actorId: user.id, action: 'article.lock_acquired', entityType: 'article', entityId: articleId, ip });
  return lock;
}

/** Renova o lease. Só funciona para o detentor do token e enquanto o bloqueio for válido. */
export async function renewLock(user: AuthUser, articleId: string, lockToken: string): Promise<LockRow> {
  const lock = await queryOne<LockRow>(
    `UPDATE article_locks SET renewed_at = now(), expires_at = now() + make_interval(secs => $4)
      WHERE article_id = $1 AND user_id = $2 AND lock_token = $3 AND expires_at > now()
      RETURNING *`,
    [articleId, user.id, lockToken, config().LOCK_TTL_SECONDS],
  );
  if (!lock) {
    const holder = await getActiveLock(articleId);
    if (holder && holder.lock_token !== lockToken) throw lockConflict(holder);
    throw conflict('LOCK_EXPIRED', 'Seu bloqueio de edição expirou. Reabra a edição para continuar; as alterações não salvas permanecem no editor.');
  }
  return lock;
}

export async function releaseLock(userId: string, articleId: string, lockToken: string, ip?: string): Promise<boolean> {
  const rows = await query(`DELETE FROM article_locks WHERE article_id = $1 AND user_id = $2 AND lock_token = $3 RETURNING article_id`, [
    articleId,
    userId,
    lockToken,
  ]);
  if (rows.length) {
    await audit({ actorId: userId, action: 'article.lock_released', entityType: 'article', entityId: articleId, ip });
  }
  return rows.length > 0;
}

/**
 * Valida, dentro da transação de salvamento, que o usuário ainda detém o bloqueio
 * válido (linha travada com FOR UPDATE para impedir liberação concorrente).
 */
export async function assertLockHeld(client: pg.PoolClient, user: AuthUser, articleId: string, lockToken: string | undefined): Promise<LockRow> {
  const lock = await queryOne<LockRow & { user_name: string }>(
    `SELECT l.*, u.name AS user_name FROM article_locks l JOIN users u ON u.id = l.user_id WHERE l.article_id = $1 FOR UPDATE OF l`,
    [articleId],
    client,
  );
  if (!lock || !lockToken || lock.lock_token !== lockToken || lock.user_id !== user.id) {
    if (lock && lock.expires_at > new Date() && lock.lock_token !== lockToken) throw lockConflict(lock);
    throw conflict('LOCK_NOT_HELD', 'Você não possui o bloqueio de edição deste artigo. Reabra a edição para obter o bloqueio antes de salvar.');
  }
  if (lock.expires_at <= new Date()) {
    throw conflict('LOCK_EXPIRED', 'Seu bloqueio de edição expirou. Reabra a edição; se o artigo não tiver sido alterado por outra pessoa, você poderá salvar.');
  }
  return lock;
}

/**
 * Para operações de status (publicar, arquivar…): não podem ocorrer enquanto
 * OUTRO usuário edita o artigo. Se o próprio usuário detém o bloqueio, o token deve conferir.
 */
export async function assertNoForeignLock(client: pg.PoolClient, user: AuthUser, articleId: string, lockToken?: string): Promise<void> {
  const lock = await queryOne<LockRow & { user_name: string }>(
    `SELECT l.*, u.name AS user_name FROM article_locks l JOIN users u ON u.id = l.user_id
      WHERE l.article_id = $1 AND l.expires_at > now() FOR UPDATE OF l`,
    [articleId],
    client,
  );
  if (!lock) return;
  if (lock.user_id === user.id && lockToken && lock.lock_token === lockToken) return;
  throw lockConflict(lock);
}

/** Liberação administrativa de bloqueio abandonado (com motivo obrigatório e auditoria). */
export async function forceReleaseLock(admin: AuthUser, articleId: string, reason: string, ip?: string): Promise<LockRow | null> {
  const lock = await queryOne<LockRow & { user_name: string }>(
    `DELETE FROM article_locks l USING users u WHERE l.article_id = $1 AND u.id = l.user_id RETURNING l.*, u.name AS user_name`,
    [articleId],
  );
  if (!lock) return null;
  await audit({
    actorId: admin.id,
    action: 'article.lock_force_released',
    entityType: 'article',
    entityId: articleId,
    data: {
      releasedBy: { id: admin.id, name: admin.name },
      holder: { id: lock.user_id, name: lock.user_name },
      acquiredAt: lock.acquired_at,
      expiresAt: lock.expires_at,
      reason,
    },
    ip,
  });
  return lock;
}

/** Remove bloqueios expirados (tarefa periódica), registrando a expiração. */
export async function purgeExpiredLocks(): Promise<number> {
  const rows = await query<{ article_id: string; user_id: string; expires_at: Date }>(
    `DELETE FROM article_locks WHERE expires_at <= now() RETURNING article_id, user_id, expires_at`,
  );
  for (const r of rows) {
    await audit({
      actorId: null,
      action: 'article.lock_expired',
      entityType: 'article',
      entityId: r.article_id,
      data: { previousUserId: r.user_id, expiredAt: r.expires_at, reason: 'Lease expirado sem renovação' },
    });
  }
  return rows.length;
}

export function serializeLock(lock: (LockRow & { user_name: string }) | null, viewer: AuthUser | null) {
  if (!lock) return { locked: false as const };
  return {
    locked: true as const,
    mine: !!viewer && lock.user_id === viewer.id,
    sameSession: !!viewer && lock.session_id === viewer.sessionId,
    holder: { id: lock.user_id, name: lock.user_name },
    acquiredAt: lock.acquired_at,
    expiresAt: lock.expires_at,
  };
}
