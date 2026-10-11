import { afterAll, describe, expect, it } from 'vitest';
import { closePool, queryOne } from '../src/db/pool.js';
import { anonymous, createArticleVia, getApp, gifBuffer, loginAs, mp4Buffer, pngBuffer, publishVia } from './helpers.js';

afterAll(async () => {
  await (await getApp()).close();
  await closePool();
});

describe('Uploads de mídia do editor (imagens, GIFs, vídeos e anexos)', () => {
  it('envia imagem, gera miniatura e registra dimensões', async () => {
    const editor = await loginAs({ roles: ['editor'] });
    const res = await editor.multipart('POST', '/api/files', { files: [{ field: 'file', filename: 'captura.png', content: await pngBuffer(800, 600), contentType: 'image/png' }] });
    expect(res.statusCode).toBe(200);
    const f = res.json().file;
    expect(f.kind).toBe('image');
    expect(f.width).toBe(800);
    expect(f.thumbnailUrl).toMatch(/^\/api\/files\//);
    const thumb = await editor.request('GET', f.thumbnailUrl);
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/webp');
  });

  it('aceita GIF animado preservando o arquivo original', async () => {
    const editor = await loginAs({ roles: ['editor'] });
    const res = await editor.multipart('POST', '/api/files', { files: [{ field: 'file', filename: 'animacao.gif', content: await gifBuffer(), contentType: 'image/gif' }] });
    expect(res.statusCode).toBe(200);
    expect(res.json().file.mimeType).toBe('image/gif');
  });

  it('envia vídeo, gera miniatura automaticamente e permite capa manual', async () => {
    const editor = await loginAs({ roles: ['editor'] });
    const res = await editor.multipart('POST', '/api/files', { files: [{ field: 'file', filename: 'tutorial.mp4', content: mp4Buffer(), contentType: 'video/mp4' }] });
    expect(res.statusCode).toBe(200);
    const video = res.json().file;
    expect(video.kind).toBe('video');
    expect(video.thumbnailUrl).toBeTruthy();
    const cover = await editor.multipart('POST', `/api/files/${video.id}/cover`, { files: [{ field: 'file', filename: 'capa.png', content: await pngBuffer(), contentType: 'image/png' }] });
    expect(cover.statusCode).toBe(200);
    expect(cover.json().file.thumbnailId).not.toBe(video.thumbnailId);
  });

  it('o streaming de vídeo suporta requisições parciais (Range) para reprodução', async () => {
    const editor = await loginAs({ roles: ['editor'] });
    const video = (await editor.multipart('POST', '/api/files', { files: [{ field: 'file', filename: 'v.mp4', content: mp4Buffer(), contentType: 'video/mp4' }] })).json().file;
    const partial = await editor.request('GET', video.url, undefined, { range: 'bytes=0-99' });
    expect(partial.statusCode).toBe(206);
    expect(partial.headers['content-range']).toMatch(/^bytes 0-99\//);
    expect(partial.rawPayload.length).toBe(100);
  });

  it('rejeita formatos não permitidos pela assinatura real do arquivo (ex.: SVG, executável renomeado)', async () => {
    const editor = await loginAs({ roles: ['editor'] });
    const svg = await editor.multipart('POST', '/api/files', {
      files: [{ field: 'file', filename: 'img.png', content: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), contentType: 'image/png' }],
    });
    expect(svg.statusCode).toBe(415);
    const exe = await editor.multipart('POST', '/api/files', {
      files: [{ field: 'file', filename: 'foto.jpg', content: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]), contentType: 'image/jpeg' }],
    });
    expect(exe.statusCode).toBe(415);
  });

  it('arquivos de artigos internos não são acessíveis externamente; de artigos externos publicados, sim', async () => {
    const publisher = await loginAs({ roles: ['editor'], grant: ['articles.publish'] });
    const up = async () => (await publisher.multipart('POST', '/api/files', { files: [{ field: 'file', filename: 'a.png', content: await pngBuffer(), contentType: 'image/png' }] })).json().file;
    const imgInternal = await up();
    const imgExternal = await up();
    const imgDraft = await up();

    const ai = await createArticleVia(publisher, { visibility: 'internal', contentHtml: `<p>x</p><img src="${imgInternal.url}" alt="interna">` });
    await publishVia(publisher, ai.id);
    const ae = await createArticleVia(publisher, { visibility: 'external', contentHtml: `<p>x</p><img src="${imgExternal.url}" alt="externa">` });
    await publishVia(publisher, ae.id);
    await createArticleVia(publisher, { visibility: 'external', contentHtml: `<p>x</p><img src="${imgDraft.url}" alt="rascunho">` });

    // Arquivos vinculados ao artigo no salvamento.
    expect((await queryOne<{ owner_id: string }>(`SELECT owner_id FROM files WHERE id = $1`, [imgInternal.id]))!.owner_id).toBe(ai.id);

    const anon = await anonymous();
    const ext = await loginAs({ type: 'external' });
    for (const s of [anon, ext]) {
      expect((await s.request('GET', imgInternal.url)).statusCode).toBe(404);
      expect((await s.request('GET', imgInternal.thumbnailUrl)).statusCode).toBe(404);
      expect((await s.request('GET', imgDraft.url)).statusCode).toBe(404);
      const ok = await s.request('GET', imgExternal.url);
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['cache-control']).toContain('private');
    }
    const restricted = await publisher.request('GET', imgInternal.url);
    expect(restricted.statusCode).toBe(200);
    expect(restricted.headers['cache-control']).toBe('private, no-store');
  });

  it('upload pendente (ainda não vinculado) só é visível para quem enviou', async () => {
    const editor = await loginAs({ roles: ['author'] });
    const f = (await editor.multipart('POST', '/api/files', { files: [{ field: 'file', filename: 'a.png', content: await pngBuffer(), contentType: 'image/png' }] })).json().file;
    expect((await editor.request('GET', f.url)).statusCode).toBe(200);
    expect((await (await loginAs({ roles: ['internal_reader'] })).request('GET', f.url)).statusCode).toBe(404);
    expect((await (await anonymous()).request('GET', f.url)).statusCode).toBe(404);
  });
});
