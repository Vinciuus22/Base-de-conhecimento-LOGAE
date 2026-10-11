import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, queryOne } from '../src/db/pool.js';
import { anonymous, createArticleVia, createUser, getApp, login, loginAs, publishVia, uid } from './helpers.js';

describe('20.1 Permissões e autorização no backend', () => {
  let internalArticle: { id: string; slug: string };
  let externalArticle: { id: string; slug: string };
  let draftArticle: { id: string; slug: string };

  beforeAll(async () => {
    const publisher = await loginAs({ roles: ['editor'], grant: ['articles.publish'] });
    internalArticle = await createArticleVia(publisher, { title: uid('Procedimento interno sigiloso '), visibility: 'internal', keywords: ['sigiloso'] });
    await publishVia(publisher, internalArticle.id);
    externalArticle = await createArticleVia(publisher, { title: uid('Artigo público '), visibility: 'external' });
    await publishVia(publisher, externalArticle.id);
    draftArticle = await createArticleVia(publisher, { title: uid('Rascunho externo '), visibility: 'external' });
  });

  afterAll(async () => {
    await (await getApp()).close();
    await closePool();
  });

  it('usuário sem permissão de publicação não consegue publicar', async () => {
    const editor = await loginAs({ roles: ['editor'] });
    const a = await createArticleVia(editor, { visibility: 'external' });
    const res = await editor.request('POST', `/api/articles/${a.id}/publish`, { expectedVersion: a.version });
    expect(res.statusCode).toBe(403);
    const row = await queryOne<{ status: string }>(`SELECT status FROM articles WHERE id = $1`, [a.id]);
    expect(row!.status).toBe('draft');
  });

  it('autor (sem permissão de publicação) consegue salvar rascunho, mas não publicar', async () => {
    const author = await loginAs({ roles: ['author'] });
    const a = await createArticleVia(author, { visibility: 'internal' });
    expect(a.id).toBeTruthy();
    const res = await author.request('POST', `/api/articles/${a.id}/publish`, { expectedVersion: a.version });
    expect(res.statusCode).toBe(403);
  });

  it('usuário interno sem perfil não recebe permissões automaticamente', async () => {
    const plain = await loginAs({ type: 'internal', roles: [] });
    const me = (await plain.request('GET', '/api/auth/me')).json().user;
    expect(me.permissions).toEqual([]);
    expect((await plain.request('POST', '/api/articles', { title: 'Teste', visibility: 'external' })).statusCode).toBe(403);
    expect((await plain.request('GET', '/api/users')).statusCode).toBe(403);
    expect((await plain.request('GET', '/api/audit')).statusCode).toBe(403);
  });

  it('usuário externo não consegue acessar o editor nem criar/editar artigos', async () => {
    const ext = await loginAs({ type: 'external' });
    expect((await ext.request('POST', '/api/articles', { title: 'Invasão', visibility: 'external' })).statusCode).toBe(403);
    expect((await ext.request('GET', '/api/articles')).statusCode).toBe(403);
    expect((await ext.request('POST', `/api/articles/${externalArticle.id}/lock`)).statusCode).toBe(403);
    expect(
      (await ext.request('PUT', `/api/articles/${externalArticle.id}`, { title: 'x', visibility: 'external', lockToken: crypto.randomUUID(), expectedVersion: 1 })).statusCode,
    ).toBe(403);
    expect((await ext.request('POST', '/api/files', {})).statusCode).toBe(403);
  });

  it('permissões internas não têm efeito para usuários externos, mesmo se concedidas no banco', async () => {
    const ext = await createUser({ type: 'external', grant: ['articles.view_internal', 'articles.create', 'users.manage'] });
    const s = await login(ext);
    const me = (await s.request('GET', '/api/auth/me')).json().user;
    expect(me.permissions).not.toContain('articles.view_internal');
    expect(me.permissions).not.toContain('users.manage');
    expect((await s.request('GET', `/api/articles/${internalArticle.slug}`)).statusCode).toBe(404);
  });

  it('artigos internos não aparecem na pesquisa externa (anônimo e cliente)', async () => {
    for (const s of [await anonymous(), await loginAs({ type: 'external' })]) {
      const res = await s.request('GET', `/api/search?q=${encodeURIComponent('sigiloso')}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().results.map((r: { id: string }) => r.id)).not.toContain(internalArticle.id);
    }
    const reader = await loginAs({ roles: ['internal_reader'] });
    const res = await reader.request('GET', `/api/search?q=sigiloso`);
    expect(res.json().results.map((r: { id: string }) => r.id)).toContain(internalArticle.id);
  });

  it('artigos internos e rascunhos não são acessíveis por URL direta (id ou slug)', async () => {
    const anon = await anonymous();
    const ext = await loginAs({ type: 'external' });
    for (const s of [anon, ext]) {
      expect((await s.request('GET', `/api/articles/${internalArticle.id}`)).statusCode).toBe(404);
      expect((await s.request('GET', `/api/articles/${internalArticle.slug}`)).statusCode).toBe(404);
      expect((await s.request('GET', `/api/articles/${draftArticle.slug}`)).statusCode).toBe(404);
      expect((await s.request('GET', `/api/articles/${externalArticle.slug}`)).statusCode).toBe(200);
    }
    // Leitor interno vê o artigo interno publicado, mas não o rascunho de terceiros.
    const reader = await loginAs({ roles: ['internal_reader'] });
    expect((await reader.request('GET', `/api/articles/${internalArticle.slug}`)).statusCode).toBe(200);
    expect((await reader.request('GET', `/api/articles/${draftArticle.slug}`)).statusCode).toBe(404);
  });

  it('a API bloqueia requisições sem token CSRF e de origem não permitida', async () => {
    const admin = await loginAs({ roles: ['admin'] });
    const app = await getApp();
    const noCsrf = await app.inject({ method: 'POST', url: '/api/categories', headers: { cookie: admin.cookie }, payload: { name: uid('Cat ') } });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe('CSRF_INVALID');
    const badOrigin = await admin.request('POST', '/api/categories', { name: uid('Cat ') }, { origin: 'https://site-malicioso.example' });
    expect(badOrigin.statusCode).toBe(403);
    const ok = await admin.request('POST', '/api/categories', { name: uid('Cat ') });
    expect(ok.statusCode).toBe(201);
  });

  it('a API bloqueia operações administrativas sem permissão', async () => {
    const support = await loginAs({ roles: ['support'] });
    expect((await support.request('POST', '/api/categories', { name: uid('C ') })).statusCode).toBe(403);
    expect((await support.request('GET', '/api/locks')).statusCode).toBe(403);
    expect((await support.request('GET', '/api/documents?removed=1')).statusCode).toBe(200); // listagem pública filtrada
    expect((await support.request('POST', '/api/documents', {})).statusCode).toBe(403);
    expect((await support.request('PUT', `/api/users/${support.userId}/permissions/users.manage`, { effect: 'grant' })).statusCode).toBe(403);
  });

  it('concessão e revogação individuais são registradas na auditoria com responsável', async () => {
    const admin = await loginAs({ roles: ['admin'] });
    const target = await createUser({ roles: ['editor'] });
    const grant = await admin.request('PUT', `/api/users/${target.id}/permissions/articles.publish`, { effect: 'grant' });
    expect(grant.statusCode).toBe(200);
    expect(grant.json().user.effectivePermissions).toContain('articles.publish');
    const deny = await admin.request('PUT', `/api/users/${target.id}/permissions/articles.edit_others`, { effect: 'deny' });
    expect(deny.json().user.effectivePermissions).not.toContain('articles.edit_others');

    const logs = await admin.request('GET', `/api/audit?entityType=user&entityId=${target.id}`);
    const actions = logs.json().items.map((i: { action: string; actor: { id: string } }) => ({ action: i.action, actor: i.actor.id }));
    expect(actions).toEqual(
      expect.arrayContaining([
        { action: 'permission.granted', actor: admin.userId },
        { action: 'permission.revoked', actor: admin.userId },
      ]),
    );
    // Permissões internas não podem ser concedidas a externos.
    const ext = await createUser({ type: 'external' });
    expect((await admin.request('PUT', `/api/users/${ext.id}/permissions/articles.create`, { effect: 'grant' })).statusCode).toBe(422);
  });

  it('a revogação de permissão tem efeito imediato (verificação a cada requisição)', async () => {
    const admin = await loginAs({ roles: ['admin'] });
    const user = await createUser({ roles: ['editor'] });
    const s = await login(user);
    expect((await s.request('GET', '/api/articles')).statusCode).toBe(200);
    await admin.request('PUT', `/api/users/${user.id}/permissions/articles.create`, { effect: 'deny' });
    expect((await s.request('POST', '/api/articles', { title: 'Sem permissão', visibility: 'internal' })).statusCode).toBe(403);
  });

  it('login inválido não revela se o e-mail existe e não registra a senha', async () => {
    const app = await getApp();
    const unknown = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'naoexiste@teste.com', password: 'qualquer123' } });
    const user = await createUser({});
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password: 'senhaErrada123' } });
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json().error.message).toBe(wrong.json().error.message);
    const log = await queryOne<{ data: unknown }>(`SELECT data FROM audit_logs WHERE action = 'auth.login_failed' ORDER BY id DESC LIMIT 1`);
    expect(JSON.stringify(log!.data)).not.toContain('senhaErrada123');
  });

  it('troca de senha exige a senha atual, valida a força e encerra as demais sessões', async () => {
    const user = await createUser({ type: 'external' });
    const s1 = await login(user);
    const s2 = await login(user);
    expect((await s1.request('POST', '/api/auth/change-password', { currentPassword: 'errada123', newPassword: 'NovaSenha123' })).statusCode).toBe(422);
    expect((await s1.request('POST', '/api/auth/change-password', { currentPassword: 'Senha12345!', newPassword: 'curta' })).statusCode).toBe(422);
    expect((await s1.request('POST', '/api/auth/change-password', { currentPassword: 'Senha12345!', newPassword: 'NovaSenha123' })).statusCode).toBe(200);
    expect((await s1.request('GET', '/api/auth/me')).json().user).not.toBeNull();
    expect((await s2.request('GET', '/api/auth/me')).json().user).toBeNull();
  });
});
