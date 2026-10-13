import { afterAll, describe, expect, it } from 'vitest';
import { closePool, getPool, query, queryOne } from '../src/db/pool.js';
import { anonymous, createArticleVia, createCategory, createSystem, getApp, loginAs, publishVia, uid, type Session } from './helpers.js';

const RICH_HTML = `
<h2 style="text-align: center">Seção principal</h2>
<p><strong>Negrito</strong>, <em>itálico</em>, <u>sublinhado</u> e <span style="color: #e11d48; font-family: Georgia; font-size: 18px">texto colorido</span>
<mark data-color="#fde68a" style="background-color: #fde68a; color: inherit">destaque</mark>.</p>
<ul><li><p>Item com marcador</p></li></ul><ol><li><p>Item numerado</p></li></ol>
<table style="min-width: 50px"><colgroup><col style="min-width: 25px"><col style="min-width: 25px"></colgroup><tbody><tr><th colspan="1" rowspan="1"><p>A</p></th><th colspan="1" rowspan="1"><p>B</p></th></tr></tbody></table>
<pre><code class="language-bash">npm run build</code></pre>
<p><a href="https://exemplo.com/doc">Link externo</a></p>
<div data-callout="atencao"><p>Bloco de atenção</p></div>
<div data-callout="dica"><p>Bloco de dica</p></div>
<div data-video="" data-provider="youtube" data-youtube-id="dQw4w9WgXcQ" data-caption="Vídeo do YouTube"></div>
<script>alert('xss')</script>
<img src="x" onerror="alert(1)">
<a href="javascript:alert(1)">link malicioso</a>
<iframe src="https://evil.example"></iframe>
<p onclick="alert(1)" style="position: fixed; text-align: right">Parágrafo</p>`;

async function save(s: Session, id: string, version: number, data: Record<string, unknown>, finish = true) {
  const lock = await s.request('POST', `/api/articles/${id}/lock`);
  if (lock.statusCode !== 200) throw new Error(lock.body);
  const current = await queryOne<{ title: string; summary: string; content_html: string; category_id: string; system_id: string; keywords: string[]; visibility: string }>(
    `SELECT * FROM articles WHERE id = $1`,
    [id],
  );
  return s.request('PUT', `/api/articles/${id}`, {
    title: current!.title,
    summary: current!.summary,
    contentHtml: current!.content_html,
    categoryId: current!.category_id,
    systemId: current!.system_id,
    keywords: current!.keywords,
    tags: [],
    visibility: current!.visibility,
    ...data,
    lockToken: lock.json().lockToken,
    expectedVersion: version,
    finish,
  });
}

afterAll(async () => {
  await (await getApp()).close();
  await closePool();
});

describe('20.3 Editor, conteúdo e publicação', () => {
  it('cria artigo com formatação rica preservada e conteúdo malicioso removido', async () => {
    const editor = await loginAs({ roles: ['editor'] });
    const a = await createArticleVia(editor, { contentHtml: RICH_HTML });
    const res = await editor.request('GET', `/api/articles/${a.id}?preview=1`);
    const html: string = res.json().article.contentHtml;
    // Formatação preservada
    for (const expected of [
      '<h2 style="text-align:center">',
      '<strong>Negrito</strong>',
      '<em>itálico</em>',
      '<u>sublinhado</u>',
      'color:#e11d48',
      'font-family:Georgia',
      'font-size:18px',
      '<mark',
      '<table',
      '<code class="language-bash">',
      'data-callout="atencao"',
      'data-callout="dica"',
      'data-youtube-id="dQw4w9WgXcQ"',
      'target="_blank"',
      'rel="noopener noreferrer nofollow"',
    ]) {
      expect(html).toContain(expected);
    }
    // Conteúdo perigoso removido
    expect(html).not.toMatch(/<script|onerror|onclick|javascript:|<iframe|position:\s*fixed/i);
    expect(html).not.toContain('<img src="x"');
  });

  it('a formatação é preservada após salvar e publicar', async () => {
    const editor = await loginAs({ roles: ['editor'], grant: ['articles.publish'] });
    const a = await createArticleVia(editor, { contentHtml: '<p>Inicial</p>' });
    const saved = await save(editor, a.id, a.version, { contentHtml: RICH_HTML });
    expect(saved.statusCode).toBe(200);
    const before = saved.json().article.contentHtml;
    await publishVia(editor, a.id);
    const after = (await (await loginAs({ type: 'external' })).request('GET', `/api/articles/${a.slug}`)).json().article.contentHtml;
    expect(after).toBe(before);
  });

  it('valida campos obrigatórios para publicação no backend', async () => {
    const editor = await loginAs({ roles: ['editor'], grant: ['articles.publish'] });
    const res = await editor.request('POST', '/api/articles', { title: uid('Incompleto '), visibility: 'external' });
    expect(res.statusCode).toBe(201);
    const a = res.json().article;
    const pub = await editor.request('POST', `/api/articles/${a.id}/publish`, { expectedVersion: a.version });
    expect(pub.statusCode).toBe(422);
    expect(Object.keys(pub.json().error.details.fields)).toEqual(expect.arrayContaining(['summary', 'contentHtml', 'categoryId', 'systemId', 'keywords']));
    // Visibilidade obrigatória na criação
    expect((await editor.request('POST', '/api/articles', { title: 'Sem visibilidade' })).statusCode).toBe(422);
  });

  it('vídeo do YouTube com id inválido é descartado; vídeo enviado mantém arquivo e capa', async () => {
    const editor = await loginAs({ roles: ['editor'] });
    const fileId = '11111111-2222-3333-4444-555555555555';
    const a = await createArticleVia(editor, {
      contentHtml: `<div data-video="" data-provider="youtube" data-youtube-id="inv@lido"></div>
        <div data-video="" data-provider="upload" data-file-id="${fileId}" data-poster-id="${fileId}" data-caption="Upload"></div>`,
    });
    const html = (await queryOne<{ content_html: string }>(`SELECT content_html FROM articles WHERE id = $1`, [a.id]))!.content_html;
    expect(html).not.toContain('inv@lido');
    expect(html).toContain(`data-file-id="${fileId}"`);
    expect(html).toContain('data-provider="upload"');
  });

  it('pré-visualização não publica nem incrementa visualizações', async () => {
    const editor = await loginAs({ roles: ['editor'] });
    const a = await createArticleVia(editor, {});
    await editor.request('GET', `/api/articles/${a.id}?preview=1`);
    const row = await queryOne<{ status: string; view_count: string }>(`SELECT status, view_count FROM articles WHERE id = $1`, [a.id]);
    expect(row!.status).toBe('draft');
    expect(Number(row!.view_count)).toBe(0);
  });

  it('autor não edita artigos de outros autores; editor sem publicação não altera artigo publicado', async () => {
    const publisher = await loginAs({ roles: ['editor'], grant: ['articles.publish'] });
    const a = await createArticleVia(publisher, { visibility: 'internal' });
    const author = await loginAs({ roles: ['author'] });
    expect((await author.request('POST', `/api/articles/${a.id}/lock`)).statusCode).toBe(404);
    await publishVia(publisher, a.id);
    const editor = await loginAs({ roles: ['editor'] });
    const res = await editor.request('POST', `/api/articles/${a.id}/lock`);
    expect(res.statusCode).toBe(403);
  });

  it('despublicar e arquivar exigem permissões específicas e removem o artigo do público', async () => {
    const publisher = await loginAs({ roles: ['editor'], grant: ['articles.publish'] });
    const a = await createArticleVia(publisher, { title: uid('Arquivável ') });
    const v = await publishVia(publisher, a.id);
    expect((await publisher.request('POST', `/api/articles/${a.id}/unpublish`, { expectedVersion: v })).statusCode).toBe(403);
    const manager = await loginAs({ roles: ['admin'] });
    const un = await manager.request('POST', `/api/articles/${a.id}/unpublish`, { expectedVersion: v });
    expect(un.statusCode).toBe(200);
    expect((await (await loginAs({ type: 'external' })).request('GET', `/api/articles/${a.slug}`)).statusCode).toBe(404);
    const ar = await manager.request('POST', `/api/articles/${a.id}/archive`, { expectedVersion: un.json().article.version });
    expect(ar.json().article.status).toBe('archived');
    // Artigo arquivado não pode ser editado até ser restaurado.
    expect((await manager.request('POST', `/api/articles/${a.id}/lock`)).statusCode).toBe(403);
  });

  it('tags inexistentes só podem ser criadas por quem gerencia categorias', async () => {
    const editor = await loginAs({ roles: ['editor'] });
    const res = await editor.request('POST', '/api/articles', { title: uid('Com tag '), visibility: 'external', tags: [uid('tagnova')] });
    expect(res.statusCode).toBe(422);
    const admin = await loginAs({ roles: ['admin'] });
    const ok = await admin.request('POST', '/api/articles', { title: uid('Com tag '), visibility: 'external', tags: [uid('tagnova')] });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().article.tags).toHaveLength(1);
  });
});

describe('20.4 Histórico de alterações', () => {
  it('registra usuário, data/hora (backend, UTC), versão e campos alterados com antes/depois', async () => {
    const editor = await loginAs({ roles: ['editor'], grant: ['articles.publish'], name: 'Hilda Histórico' });
    const cat2 = await createCategory();
    const a = await createArticleVia(editor, { title: 'Título original', visibility: 'internal' });
    const t0 = Date.now();
    const s = await save(editor, a.id, a.version, { title: 'Título novo', categoryId: cat2, visibility: 'external' });
    expect(s.statusCode).toBe(200);
    expect(s.json().article.version).toBe(2);

    const hist = await editor.request('GET', `/api/articles/${a.id}/history`);
    expect(hist.statusCode).toBe(200);
    const items = hist.json().items;
    const update = items.find((i: { operation: string }) => i.operation === 'update');
    expect(update.user.name).toBe('Hilda Histórico');
    expect(update.version).toBe(2);
    expect(update.changes.title).toEqual({ before: 'Título original', after: 'Título novo' });
    expect(update.changes.category.after).toBeTruthy();
    expect(Math.abs(new Date(update.createdAt).getTime() - t0)).toBeLessThan(60_000);
    expect(update.createdAt).toMatch(/Z$/);
    const vis = items.find((i: { operation: string }) => i.operation === 'visibility_change');
    expect(vis.changes.visibility).toEqual({ before: 'internal', after: 'external' });
    // Ordem cronológica decrescente
    const dates = items.map((i: { createdAt: string }) => new Date(i.createdAt).getTime());
    expect([...dates].sort((x, y) => y - x)).toEqual(dates);
  });

  it('registra publicação, despublicação e arquivamento', async () => {
    const admin = await loginAs({ roles: ['admin'] });
    const a = await createArticleVia(admin, {});
    let v = await publishVia(admin, a.id);
    v = (await admin.request('POST', `/api/articles/${a.id}/unpublish`, { expectedVersion: v })).json().article.version;
    await admin.request('POST', `/api/articles/${a.id}/archive`, { expectedVersion: v });
    const ops = (await admin.request('GET', `/api/articles/${a.id}/history`)).json().items.map((i: { operation: string }) => i.operation);
    expect(ops).toEqual(expect.arrayContaining(['create', 'publish', 'unpublish', 'archive']));
  });

  it('permite filtrar por usuário, período e tipo de operação', async () => {
    const e1 = await loginAs({ roles: ['editor'] });
    const e2 = await loginAs({ roles: ['editor'] });
    const a = await createArticleVia(e1, {});
    await save(e2, a.id, a.version, { title: 'Alterado por e2' });
    const byUser = (await e1.request('GET', `/api/articles/${a.id}/history?user=${e2.userId}`)).json().items;
    expect(byUser.every((i: { user: { id: string } }) => i.user.id === e2.userId)).toBe(true);
    expect(byUser.length).toBeGreaterThan(0);
    const byOp = (await e1.request('GET', `/api/articles/${a.id}/history?operation=create`)).json().items;
    expect(byOp).toHaveLength(1);
    const future = (await e1.request('GET', `/api/articles/${a.id}/history?from=2999-01-01`)).json().items;
    expect(future).toHaveLength(0);
  });

  it('consulta e compara versões; restauração cria nova versão sem apagar o histórico', async () => {
    const editor = await loginAs({ roles: ['editor'] });
    const a = await createArticleVia(editor, { title: 'Versão um', contentHtml: '<p>Texto da versão um</p>' });
    await save(editor, a.id, 1, { title: 'Versão dois', contentHtml: '<p>Texto da versão dois</p>' });
    const versions = (await editor.request('GET', `/api/articles/${a.id}/versions`)).json().items;
    expect(versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    const v1 = (await editor.request('GET', `/api/articles/${a.id}/versions/1`)).json().version;
    expect(v1.contentText).toContain('versão um');

    const restore = await editor.request('POST', `/api/articles/${a.id}/versions/1/restore`, { expectedVersion: 2 });
    expect(restore.statusCode).toBe(200);
    expect(restore.json().article.version).toBe(3);
    expect(restore.json().article.title).toBe('Versão um');
    const ops = (await editor.request('GET', `/api/articles/${a.id}/history`)).json().items.map((i: { operation: string }) => i.operation);
    expect(ops).toEqual(['restore_version', 'update', 'create']);
    expect((await query(`SELECT 1 FROM article_versions WHERE article_id = $1`, [a.id])).length).toBe(3);
  });

  it('impede a modificação do histórico (registros imutáveis no banco) e o acesso sem permissão', async () => {
    const editor = await loginAs({ roles: ['editor'] });
    const a = await createArticleVia(editor, {});
    await expect(getPool().query(`UPDATE article_history SET summary = 'adulterado' WHERE article_id = $1`, [a.id])).rejects.toThrow(/imutáveis/);
    await expect(getPool().query(`DELETE FROM article_history WHERE article_id = $1`, [a.id])).rejects.toThrow(/imutáveis/);
    await expect(getPool().query(`DELETE FROM audit_logs`)).rejects.toThrow(/imutáveis/);
    await expect(getPool().query(`UPDATE article_versions SET title = 'x' WHERE article_id = $1`, [a.id])).rejects.toThrow(/imutáveis/);
    const reader = await loginAs({ roles: ['internal_reader'] });
    expect((await reader.request('GET', `/api/articles/${a.id}/history`)).statusCode).toBe(404);
    const ext = await loginAs({ type: 'external' });
    expect((await ext.request('GET', `/api/articles/${a.id}/history`)).statusCode).toBe(403);
  });

  it('o histórico é preservado após novo login e reinicialização da aplicação', async () => {
    const editor = await loginAs({ roles: ['editor'] });
    const a = await createArticleVia(editor, {});
    const before = (await editor.request('GET', `/api/articles/${a.id}/history`)).json().items;
    // "Reinicialização": encerra o pool de conexões e reabre a aplicação/sessão.
    await closePool();
    const again = await loginAs({ roles: ['admin'] });
    const after = (await again.request('GET', `/api/articles/${a.id}/history`)).json().items;
    expect(after).toEqual(before);
  });
});

describe('Taxonomia e página inicial', () => {
  it('home lista categorias, recentes e comunicados respeitando a visibilidade', async () => {
    const admin = await loginAs({ roles: ['admin'] });
    const sys = await createSystem();
    const a = await createArticleVia(admin, { title: uid('Interno home '), visibility: 'internal', systemId: sys });
    await publishVia(admin, a.id);
    const home = (await (await loginAs({ type: 'external' })).request('GET', '/api/home')).json();
    expect(home.recent.map((r: { id: string }) => r.id)).not.toContain(a.id);
    const homeInternal = (await admin.request('GET', '/api/home')).json();
    expect(homeInternal.recent.map((r: { id: string }) => r.id)).toContain(a.id);
  });
});

describe('Histórico de leitura por usuário', () => {
  it('registra leituras do usuário logado e devolve "mais acessados por você" na home', async () => {
    const author = await loginAs({ roles: ['admin'] });
    const art = await createArticleVia(author, { visibility: 'external' });
    await publishVia(author, art.id);
    const reader = await loginAs({ type: 'external' });
    expect((await reader.request('GET', '/api/home')).json().mine).toEqual([]);
    await reader.request('GET', `/api/articles/${art.slug}`);
    await reader.request('GET', `/api/articles/${art.slug}`);
    const mine = (await reader.request('GET', '/api/home')).json().mine;
    expect(mine.map((m: { id: string }) => m.id)).toContain(art.id);
    expect((await (await anonymous()).request('GET', '/api/home')).json().mine).toEqual([]);
    const other = await loginAs({ type: 'external' });
    expect((await other.request('GET', '/api/home')).json().mine).toEqual([]);
  });
});
