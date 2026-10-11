import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '../src/db/pool.js';
import { anonymous, createArticleVia, createCategory, createSystem, getApp, loginAs, publishVia, uid, type Session } from './helpers.js';

describe('20.2 Pesquisa de artigos', () => {
  const token = uid('zq').toLowerCase(); // termo exclusivo deste teste
  let admin: Session;
  let catA: string;
  let sysA: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    admin = await loginAs({ roles: ['admin'] });
    catA = await createCategory(uid('Relatórios '));
    sysA = await createSystem(uid('ERP '));
    const mk = async (key: string, data: Parameters<typeof createArticleVia>[1], publish = true) => {
      const a = await createArticleVia(admin, data);
      if (publish) await publishVia(admin, a.id);
      ids[key] = a.id;
    };
    await mk('titulo', { title: `Exportação de relatórios ${token}`, summary: 'Como exportar.', contentHtml: '<p>Conteúdo genérico.</p>', categoryId: catA, systemId: sysA, keywords: ['exportar'] });
    await mk('conteudo', { title: `Configuração da impressora ${token}`, contentHtml: '<p>Quando ocorre falha na geração do relatório, reinicie o serviço de spooler.</p>', keywords: ['impressora'] });
    await mk('keyword', { title: `Parâmetros gerais ${token}`, contentHtml: '<p>Ajustes diversos.</p>', keywords: ['certificado digital', token] });
    await mk('interno', { title: `Rotina interna de exportação ${token}`, visibility: 'internal', keywords: ['exportar'] });
    await mk('rascunho', { title: `Exportação em rascunho ${token}`, keywords: ['exportar'] }, false);
    await query(`INSERT INTO search_synonyms (term, synonyms) VALUES ($1, ARRAY['spooler']) ON CONFLICT DO NOTHING`, [`fila${token}`]);
  });

  afterAll(async () => {
    await (await getApp()).close();
    await closePool();
  });

  const search = async (s: Session, qs: string) => {
    const res = await s.request('GET', `/api/search?${qs}`);
    expect(res.statusCode).toBe(200);
    return res.json() as { results: Array<{ id: string; title: string; headline: string; category: { name: string } | null; updatedAt: string; summary: string }>; total: number; suggestions: string[]; terms: string[] };
  };

  it('pesquisa por título (com acentuação e sem acentuação)', async () => {
    const anon = await anonymous();
    for (const q of [`exportação ${token}`, `exportacao ${token}`, `EXPORTAÇÃO ${token}`]) {
      const r = await search(anon, `q=${encodeURIComponent(q)}`);
      expect(r.results[0]?.id).toBe(ids.titulo);
    }
  });

  it('pesquisa por conteúdo e destaca os termos encontrados', async () => {
    const r = await search(await anonymous(), `q=${encodeURIComponent(`falha geração relatório ${token}`)}`);
    const hit = r.results.find((x) => x.id === ids.conteudo);
    expect(hit).toBeTruthy();
    expect(hit!.headline).toContain('\u0002');
    expect(hit!.headline).toContain('\u0003');
  });

  it('pesquisa por palavras-chave', async () => {
    const r = await search(await anonymous(), `q=${encodeURIComponent('certificado digital')}`);
    expect(r.results.map((x) => x.id)).toContain(ids.keyword);
  });

  it('considera variações de termos (stemming e prefixo)', async () => {
    const r = await search(await anonymous(), `q=${encodeURIComponent(`exportar relatorios ${token}`)}`);
    expect(r.results.map((x) => x.id)).toContain(ids.titulo);
    // Relevância: o artigo com os termos no título vem primeiro
    expect(r.results[0]!.id).toBe(ids.titulo);
  });

  it('apresenta título, resumo, categoria e data da última atualização', async () => {
    const r = await search(await anonymous(), `q=${encodeURIComponent(`exportação ${token}`)}`);
    const hit = r.results.find((x) => x.id === ids.titulo)!;
    expect(hit.title).toContain('Exportação');
    expect(hit.summary).toBe('Como exportar.');
    expect(hit.category!.name).toContain('Relatórios');
    expect(new Date(hit.updatedAt).getTime()).toBeGreaterThan(0);
  });

  it('informa quando não há resultados e sugere termos alternativos', async () => {
    const r = await search(await anonymous(), `q=${encodeURIComponent('xkcdqwerty inexistente')}`);
    expect(r.total).toBe(0);
    expect(r.results).toHaveLength(0);
    const typo = await search(await anonymous(), `q=${encodeURIComponent('impresora')}`);
    expect(typo.suggestions.join(' ')).toContain('impressora');
  });

  it('expande a pesquisa com sinônimos cadastrados', async () => {
    const r = await search(await anonymous(), `q=${encodeURIComponent(`fila${token}`)}`);
    expect(r.results.map((x) => x.id)).toContain(ids.conteudo);
  });

  it('aplica filtros de categoria, sistema e período', async () => {
    const anon = await anonymous();
    const byCat = await search(anon, `q=${token}&category=${catA}`);
    expect(byCat.results.map((x) => x.id)).toEqual([ids.titulo]);
    const bySys = await search(anon, `q=${token}&system=${sysA}`);
    expect(bySys.results.map((x) => x.id)).toEqual([ids.titulo]);
    const future = await search(anon, `q=${token}&from=2999-01-01`);
    expect(future.total).toBe(0);
  });

  it('exclui rascunhos e artigos internos dos resultados externos', async () => {
    for (const s of [await anonymous(), await loginAs({ type: 'external' })]) {
      const r = await search(s, `q=${token}&pageSize=50`);
      const found = r.results.map((x) => x.id);
      expect(found).not.toContain(ids.interno);
      expect(found).not.toContain(ids.rascunho);
      // Filtro explícito por visibilidade interna não fura o bloqueio.
      const forced = await search(s, `q=${token}&visibility=internal`);
      expect(forced.total).toBe(0);
    }
    const internal = await search(await loginAs({ roles: ['internal_reader'] }), `q=${token}&pageSize=50`);
    expect(internal.results.map((x) => x.id)).toContain(ids.interno);
    expect(internal.results.map((x) => x.id)).not.toContain(ids.rascunho);
  });

  it('sugestões não revelam termos de artigos internos para usuários externos', async () => {
    const secret = uid('confidencialissimo').toLowerCase();
    const a = await createArticleVia(admin, { title: `Plano ${secret}`, visibility: 'internal', keywords: [secret] });
    await publishVia(admin, a.id);
    const typo = secret.slice(0, -1) + 'x';
    const ext = await search(await anonymous(), `q=${encodeURIComponent(typo)}`);
    expect(ext.suggestions.join(' ')).not.toContain(secret);
  });
});
