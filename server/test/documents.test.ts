import { afterAll, describe, expect, it } from 'vitest';
import { closePool, queryOne } from '../src/db/pool.js';
import { waitForDocumentQueue } from '../src/modules/documents/service.js';
import { anonymous, docxBuffer, getApp, loginAs, pdfBuffer, uid, type Session } from './helpers.js';

afterAll(async () => {
  await (await getApp()).close();
  await closePool();
});

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function upload(s: Session, file: { filename: string; content: Buffer; contentType: string }, fields: Record<string, string> = {}) {
  const res = await s.multipart('POST', '/api/documents', {
    fields: { title: uid('Documento '), visibility: 'internal', keywords: 'manual, procedimento', ...fields },
    files: [{ field: 'file', ...file }],
  });
  await waitForDocumentQueue();
  return res;
}

async function getDoc(s: Session, id: string) {
  return (await s.request('GET', `/api/documents/${id}`)).json().document;
}

describe('20.8 Importação de documentos', () => {
  it('importa PDF válido, extrai o texto e não publica automaticamente', async () => {
    const mgr = await loginAs({ roles: ['admin'] });
    const token = uid('pdf');
    const res = await upload(mgr, { filename: 'manual.pdf', content: pdfBuffer([`Manual de instalacao ${token}`, 'Passo 1: executar o instalador.', 'Passo 2: reiniciar o servidor de aplicacao.', 'Este texto existe para garantir conteudo suficiente na pagina de teste do documento importado.']), contentType: 'application/pdf' });
    expect(res.statusCode).toBe(201);
    const doc = await getDoc(mgr, res.json().document.id);
    expect(['processed', 'processed_with_warnings']).toContain(doc.status);
    expect(doc.extractedText).toContain(token);
    expect(doc.pageCount).toBe(1);
    expect(doc.reviewStatus).toBe('pending_review');
    // Não aprovado: indisponível para pesquisa/IA e para quem não gerencia documentos.
    const chunk = await queryOne<{ available: boolean }>(`SELECT available FROM content_chunks WHERE source_type = 'document' AND source_id = $1 LIMIT 1`, [doc.id]);
    expect(chunk!.available).toBe(false);
    expect((await (await loginAs({ roles: ['internal_reader'] })).request('GET', `/api/documents/${doc.id}`)).statusCode).toBe(404);
  });

  it('importa DOCX válido preservando a referência ao arquivo original', async () => {
    const mgr = await loginAs({ roles: ['admin'] });
    const res = await upload(mgr, { filename: 'guia.docx', content: await docxBuffer('Guia de configuração', ['Configure o servidor SMTP na aba E-mail.', 'Salve e teste o envio.']), contentType: DOCX_MIME });
    expect(res.statusCode).toBe(201);
    const doc = await getDoc(mgr, res.json().document.id);
    // O DOCX mínimo do teste não define estilos: o aviso do conversor é repassado ao usuário.
    expect(['processed', 'processed_with_warnings']).toContain(doc.status);
    if (doc.status === 'processed_with_warnings') expect(doc.warnings.length).toBeGreaterThan(0);
    expect(doc.extractedText).toContain('Configure o servidor SMTP');
    expect(doc.file.name).toBe('guia.docx');
    expect((await mgr.request('GET', doc.file.url)).statusCode).toBe(200);
  });

  it('rejeita formatos não permitidos e evita duplicidade', async () => {
    const mgr = await loginAs({ roles: ['admin'] });
    const bad = await upload(mgr, { filename: 'planilha.pdf', content: Buffer.from('isto não é um pdf'), contentType: 'application/pdf' });
    expect(bad.statusCode).toBe(415);
    const content = await docxBuffer('Duplicado', [uid('conteúdo único ')]);
    expect((await upload(mgr, { filename: 'a.docx', content, contentType: DOCX_MIME })).statusCode).toBe(201);
    const dup = await upload(mgr, { filename: 'b.docx', content, contentType: DOCX_MIME });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('DUPLICATE_DOCUMENT');
  });

  it('exige classificação de visibilidade e permissão de gestão', async () => {
    const mgr = await loginAs({ roles: ['admin'] });
    const noVis = await mgr.multipart('POST', '/api/documents', {
      fields: { title: 'Sem visibilidade' },
      files: [{ field: 'file', filename: 'x.pdf', content: pdfBuffer(['abc']), contentType: 'application/pdf' }],
    });
    expect(noVis.statusCode).toBe(422);
    const editor = await loginAs({ roles: ['editor'] });
    expect((await upload(editor, { filename: 'x.pdf', content: pdfBuffer(['abc']), contentType: 'application/pdf' })).statusCode).toBe(403);
  });

  it('trata arquivos sem texto extraível (digitalizados) com mensagem clara', async () => {
    const mgr = await loginAs({ roles: ['admin'] });
    const res = await upload(mgr, { filename: 'digitalizado.pdf', content: pdfBuffer(null), contentType: 'application/pdf' });
    const doc = await getDoc(mgr, res.json().document.id);
    expect(doc.status).toBe('failed');
    expect(doc.errorMessage).toMatch(/digitalizado|OCR/);
    expect((await mgr.request('POST', `/api/documents/${doc.id}/approve`)).statusCode).toBe(409);
  });

  it('trata falhas de processamento (arquivo corrompido) e permite reprocessar', async () => {
    const mgr = await loginAs({ roles: ['admin'] });
    // DOCX corrompido: assinatura ZIP válida, conteúdo inválido.
    const corrupted = Buffer.concat([(await docxBuffer('x', ['y'])).subarray(0, 60), Buffer.alloc(200)]);
    const res = await upload(mgr, { filename: 'corrompido.docx', content: corrupted, contentType: DOCX_MIME });
    if (res.statusCode === 415) return; // assinatura não reconhecida já é tratada como formato inválido
    const doc = await getDoc(mgr, res.json().document.id);
    expect(doc.status).toBe('failed');
    expect(doc.errorMessage).toBeTruthy();
    const re = await mgr.request('POST', `/api/documents/${doc.id}/reprocess`);
    expect(re.statusCode).toBe(200);
    await waitForDocumentQueue();
    expect((await getDoc(mgr, doc.id)).attempts).toBe(2);
  });

  it('indexa após aprovação e a IA consulta conforme a visibilidade', async () => {
    const mgr = await loginAs({ roles: ['admin'] });
    const tokenInt = uid('docint').toLowerCase();
    const tokenExt = uid('docext').toLowerCase();
    const di = (await upload(mgr, { filename: 'i.docx', content: await docxBuffer('Interno', [`Procedimento confidencial ${tokenInt} para a equipe.`]), contentType: DOCX_MIME }, { visibility: 'internal' })).json().document;
    const de = (await upload(mgr, { filename: 'e.docx', content: await docxBuffer('Externo', [`Guia do cliente ${tokenExt} para configurar a impressora.`]), contentType: DOCX_MIME }, { visibility: 'external' })).json().document;
    expect((await mgr.request('POST', `/api/documents/${di.id}/approve`)).statusCode).toBe(200);
    expect((await mgr.request('POST', `/api/documents/${de.id}/approve`)).statusCode).toBe(200);

    const anon = await anonymous();
    const extAnswer = (await anon.request('POST', '/api/chat', { message: `guia do cliente ${tokenExt}` })).json();
    expect(extAnswer.message.sources.map((s: { id: string }) => s.id)).toContain(de.id);
    expect(extAnswer.message.sources[0].url).toBe(`/documentos/${de.id}`);

    // Documento interno: bloqueado para externos (chat, metadados e download).
    const blocked = (await anon.request('POST', '/api/chat', { message: `procedimento confidencial ${tokenInt}` })).json();
    expect(blocked.message.sources.map((s: { id: string }) => s.id)).not.toContain(di.id);
    const ext = await loginAs({ type: 'external' });
    expect((await ext.request('GET', `/api/documents/${di.id}`)).statusCode).toBe(404);
    expect((await ext.request('GET', `/api/files/${di.file.id}`)).statusCode).toBe(404);
    expect((await ext.request('GET', `/api/documents/${de.id}`)).statusCode).toBe(200);

    const reader = await loginAs({ roles: ['internal_reader'] });
    const intAnswer = (await reader.request('POST', '/api/chat', { message: `procedimento confidencial ${tokenInt}` })).json();
    expect(intAnswer.message.sources.map((s: { id: string }) => s.id)).toContain(di.id);
  });

  it('tornar um documento aprovado externo exige nova aprovação', async () => {
    const mgr = await loginAs({ roles: ['admin'] });
    const d = (await upload(mgr, { filename: 'v.docx', content: await docxBuffer('V', [uid('texto ')]), contentType: DOCX_MIME })).json().document;
    await mgr.request('POST', `/api/documents/${d.id}/approve`);
    const res = await mgr.request('PUT', `/api/documents/${d.id}`, { title: d.title, visibility: 'external', keywords: [] });
    expect(res.json().requiresNewReview).toBe(true);
    expect(res.json().document.reviewStatus).toBe('pending_review');
    expect((await (await anonymous()).request('GET', `/api/documents/${d.id}`)).statusCode).toBe(404);
  });

  it('remoção autorizada retira o documento da IA, apaga o arquivo e mantém rastreabilidade', async () => {
    const mgr = await loginAs({ roles: ['admin'] });
    const d = (await upload(mgr, { filename: 'r.docx', content: await docxBuffer('R', [uid('remover ')]), contentType: DOCX_MIME })).json().document;
    await mgr.request('POST', `/api/documents/${d.id}/approve`);
    expect((await (await loginAs({ roles: ['editor'] })).request('DELETE', `/api/documents/${d.id}`, { reason: 'teste' })).statusCode).toBe(403);
    expect((await mgr.request('DELETE', `/api/documents/${d.id}`, { reason: 'Documento obsoleto' })).statusCode).toBe(200);
    expect(await queryOne(`SELECT 1 FROM content_chunks WHERE source_id = $1`, [d.id])).toBeNull();
    expect((await mgr.request('GET', `/api/files/${d.file.id}`)).statusCode).toBe(404);
    const log = await queryOne<{ data: { reason: string } }>(`SELECT data FROM audit_logs WHERE action = 'document.remove' AND entity_id = $1`, [d.id]);
    expect(log!.data.reason).toBe('Documento obsoleto');
  });

  it('gera rascunho de artigo a partir do documento, mantendo o vínculo', async () => {
    const mgr = await loginAs({ roles: ['admin'] });
    const d = (await upload(mgr, { filename: 'art.docx', content: await docxBuffer('Base', ['Parágrafo um.', 'Parágrafo dois.']), contentType: DOCX_MIME })).json().document;
    const res = await mgr.request('POST', `/api/documents/${d.id}/create-article`);
    expect(res.statusCode).toBe(201);
    const a = await queryOne<{ status: string }>(`SELECT status FROM articles WHERE id = $1`, [res.json().article.id]);
    expect(a!.status).toBe('draft');
    const detail = await getDoc(mgr, d.id);
    expect(detail.relatedArticles.map((x: { id: string }) => x.id)).toContain(res.json().article.id);
  });
});
