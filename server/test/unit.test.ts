import { describe, expect, it } from 'vitest';
import { computeEffectivePermissions } from '@shared/permissions.js';
import { buildLockMessage } from '@shared/domain.js';
import { parseYouTubeStart, parseYouTubeUrl, youTubeEmbedUrl, youTubeThumbnailUrl } from '@shared/youtube.js';
import { referencedFileIds, sanitizeRichHtml } from '../src/lib/sanitize.js';
import { chunkText, htmlToText, slugify } from '../src/lib/text.js';
import { redact } from '../src/lib/audit.js';
import { stripUrls } from '../src/modules/ai/routes.js';

describe('YouTube', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['youtu.be/dQw4w9WgXcQ?si=abc', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/live/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ])('aceita %s', (url, id) => {
    expect(parseYouTubeUrl(url)).toBe(id);
  });

  it.each([
    'https://evil.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ',
    'javascript:alert(1)',
    'https://www.youtube.com/watch?v=curto',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ"><script>',
    '',
  ])('rejeita %s', (url) => {
    expect(parseYouTubeUrl(url)).toBeNull();
  });

  it('gera endereços seguros a partir do identificador', () => {
    expect(youTubeEmbedUrl('dQw4w9WgXcQ', { autoplay: true, start: 42 })).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0&modestbranding=1&playsinline=1&autoplay=1&start=42',
    );
    expect(youTubeThumbnailUrl('dQw4w9WgXcQ')).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    expect(() => youTubeEmbedUrl('<x>')).toThrow();
    expect(parseYouTubeStart('https://youtu.be/dQw4w9WgXcQ?t=1m30s')).toBe(90);
  });
});

describe('Sanitização', () => {
  it('remove XSS e preserva os blocos próprios', () => {
    const out = sanitizeRichHtml(
      `<div data-callout="importante" onclick="x()"><p>ok</p></div><div data-callout="inexistente"><p>a</p></div>
       <img src="/api/files/11111111-2222-3333-4444-555555555555" onload="x()"><img src="https://evil/x.png">
       <a href="//evil.com">a</a><a href="/artigos/x">b</a><svg><script>1</script></svg><style>body{}</style>`,
    );
    expect(out).toContain('data-callout="importante"');
    expect(out).toContain('data-callout="info"');
    expect(out).toContain('src="/api/files/11111111-2222-3333-4444-555555555555"');
    expect(out).not.toMatch(/onclick|onload|evil|<svg|<script|<style/);
    expect(out).toContain('href="/artigos/x"');
  });

  it('identifica os arquivos referenciados no conteúdo', () => {
    const id1 = '11111111-2222-3333-4444-555555555555';
    const id2 = '66666666-7777-8888-9999-000000000000';
    expect(referencedFileIds(`<img src="/api/files/${id1}"><div data-video data-file-id="${id2}"></div>`).sort()).toEqual([id1, id2].sort());
  });
});

describe('Utilitários', () => {
  it('converte HTML em texto e gera slugs sem acentos', () => {
    expect(htmlToText('<h2>Título</h2><p>Olá &amp; até&nbsp;logo</p>')).toBe('Título\nOlá & até logo');
    expect(slugify('Exportação de Relatórios — PDF!')).toBe('exportacao-de-relatorios-pdf');
  });

  it('divide textos longos em trechos com sobreposição e título da seção', () => {
    const text = ['Introdução', 'a '.repeat(400), 'Configuração', 'b '.repeat(700)].join('\n');
    const chunks = chunkText(text, { maxChars: 500, overlap: 50, headings: ['Introdução', 'Configuração'] });
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => c.content.length <= 500)).toBe(true);
    expect(chunks.at(-1)!.heading).toBe('Configuração');
  });

  it('remove senhas e tokens dos registros de auditoria', () => {
    expect(redact({ email: 'a@b.com', password: '123', nested: { apiKey: 'k', token: 't', ok: 1 } })).toEqual({
      email: 'a@b.com',
      password: '[removido]',
      nested: { apiKey: '[removido]', token: '[removido]', ok: 1 },
    });
  });

  it('remove URLs geradas pela IA', () => {
    expect(stripUrls('Veja https://x.com/a e www.y.com/b agora')).toBe('Veja  e  agora');
  });

  it('calcula permissões efetivas com concessões, revogações e tipo de usuário', () => {
    expect(computeEffectivePermissions('internal', ['articles.create'], ['articles.publish'], ['articles.create'])).toEqual(['articles.publish']);
    expect(computeEffectivePermissions('external', [], ['articles.create', 'tickets.view_company'], [])).toEqual(['tickets.view_company']);
  });

  it('monta a mensagem de bloqueio com os dados reais', () => {
    expect(buildLockMessage('Maria', '11/10/2026', '14:32')).toBe(
      'Este artigo está sendo editado por Maria desde 11/10/2026 às 14:32. Para evitar alterações conflitantes, a edição está temporariamente bloqueada. Tente novamente quando o artigo estiver disponível.',
    );
  });
});
