import { afterAll, describe, expect, it } from 'vitest';
import { closePool, query, queryOne } from '../src/db/pool.js';
import { purgeExpiredLocks } from '../src/modules/articles/locks.js';
import { createArticleVia, getApp, loginAs, type Session } from './helpers.js';

const body = (overrides: Record<string, unknown> = {}) => ({
  title: 'Título atualizado',
  summary: 'Resumo atualizado',
  contentHtml: '<p>Conteúdo atualizado</p>',
  keywords: ['teste'],
  tags: [],
  visibility: 'external',
  ...overrides,
});

async function acquire(s: Session, id: string) {
  return s.request('POST', `/api/articles/${id}/lock`);
}

describe('20.5 Bloqueio de edição simultânea', () => {
  afterAll(async () => {
    await (await getApp()).close();
    await closePool();
  });

  it('o primeiro usuário que adquire o bloqueio edita; o segundo recebe o nome do responsável', async () => {
    const owner = await loginAs({ roles: ['editor'] });
    const a = await createArticleVia(owner, {});
    const first = await loginAs({ roles: ['editor'], name: 'Maria Primeira' });
    const second = await loginAs({ roles: ['editor'], name: 'João Segundo' });

    const r1 = await acquire(first, a.id);
    expect(r1.statusCode).toBe(200);
    expect(r1.json().lockToken).toMatch(/^[0-9a-f-]{36}$/);

    const r2 = await acquire(second, a.id);
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error.code).toBe('ARTICLE_LOCKED');
    expect(r2.json().error.details.holder.name).toBe('Maria Primeira');
    expect(r2.json().error.details.holder.acquiredAt).toBeTruthy();

    // Estado de bloqueio visível para os demais (botão "Editar" desabilitado na interface).
    const view = await second.request('GET', `/api/articles/${a.id}`);
    expect(view.json().lock).toMatchObject({ locked: true, mine: false, holder: { name: 'Maria Primeira' } });
  });

  it('dois usuários concorrentes não adquirem o bloqueio ao mesmo tempo (aquisição atômica)', async () => {
    const owner = await loginAs({ roles: ['editor'] });
    const a = await createArticleVia(owner, {});
    const sessions = await Promise.all(Array.from({ length: 8 }, () => loginAs({ roles: ['editor'] })));
    const results = await Promise.all(sessions.map((s) => acquire(s, a.id)));
    const ok = results.filter((r) => r.statusCode === 200);
    const conflicts = results.filter((r) => r.statusCode === 409);
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(7);
    const locks = await query(`SELECT * FROM article_locks WHERE article_id = $1`, [a.id]);
    expect(locks).toHaveLength(1);
  });

  it('o mesmo usuário em outra sessão também não obtém o bloqueio', async () => {
    const owner = await loginAs({ roles: ['editor'] });
    const a = await createArticleVia(owner, {});
    expect((await acquire(owner, a.id)).statusCode).toBe(200);
    const app = await getApp();
    const relog = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: (await queryOne<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [owner.userId]))!.email, password: 'Senha12345!' } });
    const cookie = String(relog.headers['set-cookie']).split(';')[0]!;
    const other = await app.inject({ method: 'POST', url: `/api/articles/${a.id}/lock`, headers: { cookie, 'x-csrf-token': relog.json().csrfToken } });
    expect(other.statusCode).toBe(409);
  });

  it('o bloqueio é liberado ao concluir (salvar e finalizar) e ao cancelar', async () => {
    const editor = await loginAs({ roles: ['editor'] });
    const other = await loginAs({ roles: ['editor'] });
    const a = await createArticleVia(editor, {});
    const lock = (await acquire(editor, a.id)).json();
    const save = await editor.request('PUT', `/api/articles/${a.id}`, body({ lockToken: lock.lockToken, expectedVersion: a.version, finish: true }));
    expect(save.statusCode).toBe(200);
    expect(save.json().lockReleased).toBe(true);
    expect((await acquire(other, a.id)).statusCode).toBe(200);

    const b = await createArticleVia(editor, {});
    const lockB = (await acquire(editor, b.id)).json();
    const cancel = await editor.request('DELETE', `/api/articles/${b.id}/lock`, { lockToken: lockB.lockToken });
    expect(cancel.json().released).toBe(true);
    expect((await acquire(other, b.id)).statusCode).toBe(200);
  });

  it('liberação por sendBeacon (fechamento da aba) exige o token secreto do bloqueio', async () => {
    const editor = await loginAs({ roles: ['editor'] });
    const a = await createArticleVia(editor, {});
    const lock = (await acquire(editor, a.id)).json();
    const app = await getApp();
    const wrong = await app.inject({
      method: 'POST',
      url: `/api/articles/${a.id}/lock/beacon`,
      headers: { cookie: editor.cookie, 'content-type': 'text/plain' },
      payload: JSON.stringify({ lockToken: crypto.randomUUID() }),
    });
    expect(wrong.json().released).toBe(false);
    const right = await app.inject({
      method: 'POST',
      url: `/api/articles/${a.id}/lock/beacon`,
      headers: { cookie: editor.cookie, 'content-type': 'text/plain' },
      payload: JSON.stringify({ lockToken: lock.lockToken }),
    });
    expect(right.json().released).toBe(true);
  });

  it('a renovação (heartbeat) estende o lease somente para o detentor', async () => {
    const editor = await loginAs({ roles: ['editor'] });
    const intruder = await loginAs({ roles: ['editor'] });
    const a = await createArticleVia(editor, {});
    const lock = (await acquire(editor, a.id)).json();
    const before = await queryOne<{ expires_at: Date }>(`SELECT expires_at FROM article_locks WHERE article_id = $1`, [a.id]);
    await new Promise((r) => setTimeout(r, 20));
    const hb = await editor.request('POST', `/api/articles/${a.id}/lock/heartbeat`, { lockToken: lock.lockToken });
    expect(hb.statusCode).toBe(200);
    expect(new Date(hb.json().expiresAt).getTime()).toBeGreaterThan(new Date(before!.expires_at).getTime());
    const bad = await intruder.request('POST', `/api/articles/${a.id}/lock/heartbeat`, { lockToken: lock.lockToken });
    expect(bad.statusCode).toBe(409);
  });

  it('bloqueios abandonados expiram de forma controlada (somente após o fim do lease)', async () => {
    const editor = await loginAs({ roles: ['editor'] });
    const other = await loginAs({ roles: ['editor'] });
    const a = await createArticleVia(editor, {});
    const lock = (await acquire(editor, a.id)).json();

    // Lease ainda válido: a limpeza periódica NÃO remove sessão ativa.
    await purgeExpiredLocks();
    expect((await acquire(other, a.id)).statusCode).toBe(409);

    // Simula o fechamento inesperado do navegador: sem renovação, o lease expira.
    await query(`UPDATE article_locks SET expires_at = now() - interval '1 second' WHERE article_id = $1`, [a.id]);
    const taken = await acquire(other, a.id);
    expect(taken.statusCode).toBe(200);
    const expiredLog = await queryOne(`SELECT * FROM audit_logs WHERE action = 'article.lock_expired' AND entity_id = $1`, [a.id]);
    expect(expiredLog).toBeTruthy();

    // A sessão antiga não consegue mais salvar nem renovar.
    const stale = await editor.request('PUT', `/api/articles/${a.id}`, body({ lockToken: lock.lockToken, expectedVersion: a.version }));
    expect(stale.statusCode).toBe(409);
    expect((await editor.request('POST', `/api/articles/${a.id}/lock/heartbeat`, { lockToken: lock.lockToken })).statusCode).toBe(409);
  });

  it('a limpeza periódica remove bloqueios expirados e registra auditoria', async () => {
    const editor = await loginAs({ roles: ['editor'] });
    const a = await createArticleVia(editor, {});
    await acquire(editor, a.id);
    await query(`UPDATE article_locks SET expires_at = now() - interval '5 seconds' WHERE article_id = $1`, [a.id]);
    const removed = await purgeExpiredLocks();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await queryOne(`SELECT 1 FROM article_locks WHERE article_id = $1`, [a.id])).toBeNull();
  });

  it('sessões antigas não sobrescrevem versões mais recentes (concorrência otimista)', async () => {
    const editor = await loginAs({ roles: ['editor'] });
    const a = await createArticleVia(editor, {});
    const lock = (await acquire(editor, a.id)).json();
    const s1 = await editor.request('PUT', `/api/articles/${a.id}`, body({ title: 'Versão 2', lockToken: lock.lockToken, expectedVersion: a.version }));
    expect(s1.statusCode).toBe(200);
    // Mesmo com o bloqueio, enviar a versão antiga é rejeitado.
    const s2 = await editor.request('PUT', `/api/articles/${a.id}`, body({ title: 'Sobrescrita antiga', lockToken: lock.lockToken, expectedVersion: a.version }));
    expect(s2.statusCode).toBe(409);
    expect(s2.json().error.code).toBe('VERSION_CONFLICT');
    const row = await queryOne<{ title: string }>(`SELECT title FROM articles WHERE id = $1`, [a.id]);
    expect(row!.title).toBe('Versão 2');
    const rejected = await queryOne(`SELECT * FROM article_history WHERE article_id = $1 AND operation = 'save_rejected'`, [a.id]);
    expect(rejected).toBeTruthy();
  });

  it('salvar sem bloqueio é rejeitado; perda de autorização também invalida o salvamento', async () => {
    const editor = await loginAs({ roles: ['editor'] });
    const a = await createArticleVia(editor, {});
    const noLock = await editor.request('PUT', `/api/articles/${a.id}`, body({ lockToken: crypto.randomUUID(), expectedVersion: a.version }));
    expect(noLock.statusCode).toBe(409);
    expect(noLock.json().error.code).toBe('LOCK_NOT_HELD');

    const lock = (await acquire(editor, a.id)).json();
    await query(`INSERT INTO user_permissions (user_id, permission_key, effect) VALUES ($1, 'articles.edit', 'deny'), ($1, 'articles.edit_others', 'deny')`, [editor.userId]);
    const denied = await editor.request('PUT', `/api/articles/${a.id}`, body({ lockToken: lock.lockToken, expectedVersion: a.version }));
    expect(denied.statusCode).toBe(403);
  });

  it('publicar enquanto outro usuário edita é bloqueado', async () => {
    const editor = await loginAs({ roles: ['editor'] });
    const publisher = await loginAs({ roles: ['editor'], grant: ['articles.publish'] });
    const a = await createArticleVia(editor, {});
    await acquire(editor, a.id);
    const res = await publisher.request('POST', `/api/articles/${a.id}/publish`, { expectedVersion: a.version });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ARTICLE_LOCKED');
  });

  it('liberação administrativa exige permissão, motivo e gera auditoria; a sessão antiga não salva', async () => {
    const editor = await loginAs({ roles: ['editor'], name: 'Editor Ausente' });
    const admin = await loginAs({ roles: ['admin'], name: 'Admin Responsável' });
    const nonAdmin = await loginAs({ roles: ['editor'] });
    const a = await createArticleVia(editor, {});
    const lock = (await acquire(editor, a.id)).json();

    expect((await nonAdmin.request('POST', `/api/locks/${a.id}/release`, { reason: 'Tentativa sem permissão' })).statusCode).toBe(403);
    expect((await admin.request('POST', `/api/locks/${a.id}/release`, { reason: '' })).statusCode).toBe(422);
    const rel = await admin.request('POST', `/api/locks/${a.id}/release`, { reason: 'Usuário saiu sem encerrar a edição' });
    expect(rel.statusCode).toBe(200);

    const log = await queryOne<{ actor_id: string; data: Record<string, any>; created_at: Date }>(
      `SELECT actor_id, data, created_at FROM audit_logs WHERE action = 'article.lock_force_released' AND entity_id = $1`,
      [a.id],
    );
    expect(log!.actor_id).toBe(admin.userId);
    expect(log!.data.holder.name).toBe('Editor Ausente');
    expect(log!.data.reason).toBe('Usuário saiu sem encerrar a edição');
    expect(log!.created_at).toBeInstanceOf(Date);

    // Outro editor altera o artigo; a sessão antiga não consegue sobrescrever.
    const lock2 = (await acquire(nonAdmin, a.id)).json();
    expect((await nonAdmin.request('PUT', `/api/articles/${a.id}`, body({ title: 'Nova versão', lockToken: lock2.lockToken, expectedVersion: a.version, finish: true }))).statusCode).toBe(200);
    const stale = await editor.request('PUT', `/api/articles/${a.id}`, body({ title: 'Versão antiga', lockToken: lock.lockToken, expectedVersion: a.version }));
    expect(stale.statusCode).toBe(409);
    expect((await queryOne<{ title: string }>(`SELECT title FROM articles WHERE id = $1`, [a.id]))!.title).toBe('Nova versão');
  });
});
