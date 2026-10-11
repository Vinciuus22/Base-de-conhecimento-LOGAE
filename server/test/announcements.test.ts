import { afterAll, describe, expect, it } from 'vitest';
import { closePool, query, queryOne } from '../src/db/pool.js';
import { TEST_ACCOUNTS } from '../src/db/test-accounts.js';
import { seed } from '../src/db/seed.js';
import { anonymous, createSystem, getApp, gifBuffer, loginAs, pngBuffer, mp4Buffer, uid } from './helpers.js';

afterAll(async () => {
  await (await getApp()).close();
  await closePool();
});

describe('Comunicados — exclusivos para usuários internos', () => {
  async function create(s: Awaited<ReturnType<typeof loginAs>>, over: Record<string, unknown> = {}) {
    return s.request('POST', '/api/announcements', {
      title: uid('Aviso '),
      contentHtml: '<p>Conteúdo do aviso.</p>',
      category: 'comunicado',
      systemIds: [await createSystem()],
      ...over,
    });
  }

  it('somente quem tem permissão cadastra; externos e leitores não', async () => {
    const manager = await loginAs({ roles: ['editor'], grant: ['announcements.manage'] });
    expect((await create(manager)).statusCode).toBe(201);
    for (const s of [await loginAs({ roles: ['internal_reader'] }), await loginAs({ type: 'external' }), await anonymous()]) {
      expect((await create(s)).statusCode).toBeGreaterThanOrEqual(401);
    }
  });

  it('exige vínculo com pelo menos uma plataforma e permite várias', async () => {
    const manager = await loginAs({ roles: ['admin'] });
    expect((await create(manager, { systemIds: [] })).statusCode).toBe(422);
    expect((await create(manager, { systemIds: [crypto.randomUUID()] })).statusCode).toBe(422);
    const [a, b] = [await createSystem(uid('Plat A ')), await createSystem(uid('Plat B '))];
    const res = await create(manager, { systemIds: [a, b] });
    expect(res.statusCode).toBe(201);
    expect(res.json().announcement.systems).toHaveLength(2);
    const filtered = await manager.request('GET', `/api/announcements?manage=1&system=${b}`);
    expect(filtered.json().items.map((i: { id: string }) => i.id)).toContain(res.json().announcement.id);
  });

  it('comunicados nunca são exibidos a clientes ou visitantes (lista, detalhe e arquivos)', async () => {
    const manager = await loginAs({ roles: ['admin'] });
    const png = (await manager.multipart('POST', '/api/files', { files: [{ field: 'file', filename: 'a.png', content: await pngBuffer(), contentType: 'image/png' }] })).json().file;
    const video = (await manager.multipart('POST', '/api/files', { files: [{ field: 'file', filename: 'v.mp4', content: mp4Buffer(), contentType: 'video/mp4' }] })).json().file;
    const gif = (await manager.multipart('POST', '/api/files', { files: [{ field: 'file', filename: 'g.gif', content: await gifBuffer(), contentType: 'image/gif' }] })).json().file;
    const html = `<p>Veja:</p><img src="${png.url}" alt="x"><img src="${gif.url}" alt="g"><div data-video="" data-provider="upload" data-file-id="${video.id}"></div>`;
    const created = (await create(manager, { contentHtml: html })).json().announcement;
    await manager.request('POST', `/api/announcements/${created.id}/publish`);

    const reader = await loginAs({ roles: ['internal_reader'] });
    const list = (await reader.request('GET', '/api/announcements')).json();
    expect(list.items.map((i: { id: string }) => i.id)).toContain(created.id);
    expect((await reader.request('GET', `/api/announcements/${created.id}`)).json().announcement.contentHtml).toContain(png.url);
    expect((await reader.request('GET', png.url)).statusCode).toBe(200);
    expect((await reader.request('GET', video.url)).statusCode).toBe(200);

    for (const s of [await loginAs({ type: 'external' }), await anonymous()]) {
      expect([401, 403]).toContain((await s.request('GET', '/api/announcements')).statusCode);
      expect((await s.request('GET', `/api/announcements/${created.id}`)).statusCode).toBeGreaterThanOrEqual(401);
      for (const f of [png, video, gif]) expect((await s.request('GET', f.url)).statusCode).toBe(404);
    }
  });

  it('rascunhos só aparecem para gestores; a visibilidade externa é impossível no banco', async () => {
    const manager = await loginAs({ roles: ['admin'] });
    const draft = (await create(manager)).json().announcement;
    const reader = await loginAs({ roles: ['internal_reader'] });
    expect((await reader.request('GET', `/api/announcements/${draft.id}`)).statusCode).toBe(404);
    expect((await manager.request('GET', `/api/announcements/${draft.id}`)).statusCode).toBe(200);
    await expect(query(`UPDATE announcements SET visibility = 'external' WHERE id = $1`, [draft.id])).rejects.toThrow(/announcements_internal_only/);
  });

  it('comunicados não aparecem na página inicial pública (somente atualizações)', async () => {
    const home = (await (await anonymous()).request('GET', '/api/home')).json();
    expect(home.announcements).toBeUndefined();
    expect(Array.isArray(home.updates)).toBe(true);
  });
});

describe('Contas de teste', () => {
  it('criam um usuário interno (admin) e um externo, e fazem login', async () => {
    await seed({ adminEmail: 'admin-teste@exemplo.com', adminPassword: 'Admin12345!', demo: false, testUsers: true });
    const app = await getApp();
    const [internal, external] = TEST_ACCOUNTS;
    const loginAs2 = async (a: { email: string; password: string }) => {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: a.email, password: a.password } });
      expect(r.statusCode).toBe(200);
      const cookie = String(r.headers['set-cookie']).split(';')[0]!;
      return (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json().user;
    };
    const i = await loginAs2(internal);
    expect(i.userType).toBe('internal');
    expect(i.roles).toContain('admin');
    expect(i.permissions).toContain('updates.manage');
    const e = await loginAs2(external);
    expect(e.userType).toBe('external');
    expect(e.company.name).toBe('Empresa de Teste');
    expect(e.permissions).not.toContain('articles.create');
    // Idempotente
    await seed({ adminEmail: 'admin-teste@exemplo.com', adminPassword: 'Admin12345!', demo: false, testUsers: true });
    expect((await queryOne<{ n: string }>(`SELECT count(*) AS n FROM users WHERE email = ANY($1::text[])`, [[internal.email, external.email]]))!.n).toBe('2');
    const cfg = (await app.inject({ method: 'GET', url: '/api/config' })).json();
    expect(cfg.testAccounts).toHaveLength(2);
  });
});
