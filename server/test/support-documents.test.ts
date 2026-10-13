import { afterAll, describe, expect, it } from 'vitest';
import { closePool, queryOne } from '../src/db/pool.js';
import { anonymous, createSystem, getApp, loginAs, pdfBuffer, uid } from './helpers.js';

afterAll(async () => {
  await (await getApp()).close();
  await closePool();
});

describe('Documentos de apoio', () => {
  async function post(s: Awaited<ReturnType<typeof loginAs>>, fields: Record<string, string>, file?: { filename: string; content: Buffer; contentType?: string }) {
    return s.multipart('POST', '/api/support-documents', { fields, files: file ? [{ field: 'file', ...file }] : [] });
  }
  const base = async () => ({ title: uid('API de pedidos '), type: 'api', systemId: await createSystem(), visibility: 'internal', description: 'Para que serve' });

  it('exige permissão de gerenciar documentos', async () => {
    const reader = await loginAs({ roles: ['internal_reader'] });
    const external = await loginAs({ type: 'external' });
    for (const s of [reader, external, await anonymous()]) {
      expect((await s.request('GET', '/api/support-documents')).statusCode).toBeGreaterThanOrEqual(401);
      expect((await post(s, await base(), { filename: 'a.txt', content: Buffer.from('x') })).statusCode).toBeGreaterThanOrEqual(401);
    }
  });

  it('valida obrigatórios: título, tipo, sistema, visibilidade e arquivo ou link', async () => {
    const admin = await loginAs({ roles: ['admin'] });
    const ok = await base();
    expect((await post(admin, ok)).statusCode).toBe(422); // sem arquivo nem link
    for (const k of ['title', 'type', 'systemId', 'visibility']) {
      const f = { ...ok, externalUrl: 'https://exemplo.com/doc' } as Record<string, string>;
      delete f[k];
      expect((await post(admin, f)).statusCode, k).toBe(422);
    }
    expect((await post(admin, { ...ok, externalUrl: 'javascript:alert(1)' })).statusCode).toBe(422);
    expect((await post(admin, { ...ok, externalUrl: 'https://exemplo.com/doc' })).statusCode).toBe(201);
  });

  it('aceita PDF, JSON e texto; recusa executáveis; arquivo segue a visibilidade do documento', async () => {
    const admin = await loginAs({ roles: ['admin'] });
    const internalDoc = await post(admin, await base(), { filename: 'manual.pdf', content: pdfBuffer(['Manual']), contentType: 'application/pdf' });
    expect(internalDoc.statusCode, internalDoc.body).toBe(201);
    const j = await post(admin, { ...(await base()), visibility: 'external' }, { filename: 'spec.json', content: Buffer.from('{"a":1}'), contentType: 'application/json' });
    expect(j.statusCode, j.body).toBe(201);
    expect((await post(admin, await base(), { filename: 'virus.exe', content: Buffer.from('MZ\x90\x00binary'), contentType: 'application/octet-stream' })).statusCode).toBe(415);

    const reader = await loginAs({ roles: ['internal_reader'] });
    const external = await loginAs({ type: 'external' });
    const anon = await anonymous();
    const intUrl = internalDoc.json().document.file.url as string;
    const extUrl = j.json().document.file.url as string;
    expect((await admin.request('GET', intUrl)).statusCode).toBe(200);
    expect((await reader.request('GET', intUrl)).statusCode).toBe(200);
    for (const s of [external, anon]) expect((await s.request('GET', intUrl)).statusCode).toBe(404);
    for (const s of [external, anon]) expect((await s.request('GET', extUrl)).statusCode).toBe(200);
  });

  it('lista com filtros (sem acento), remove logicamente e registra auditoria', async () => {
    const admin = await loginAs({ roles: ['admin'] });
    const sys = await createSystem(uid('Sis '));
    const title = uid('Requisição de cadastro ');
    const created = await post(admin, { title, type: 'requisicao', systemId: sys, visibility: 'internal', externalUrl: 'https://exemplo.com/x' });
    const id = created.json().document.id as string;
    const names = async (qs: string) => ((await admin.request('GET', `/api/support-documents${qs}`)).json().items as Array<{ id: string }>).map((i) => i.id);
    expect(await names(`?q=${encodeURIComponent('REQUISICAO DE CADASTRO')}&system=${sys}&type=requisicao`)).toContain(id);
    expect(await names(`?system=${sys}&type=api`)).not.toContain(id);
    expect((await admin.request('DELETE', `/api/support-documents/${id}`)).statusCode).toBe(200);
    expect(await names(`?system=${sys}`)).not.toContain(id);
    expect(await queryOne(`SELECT 1 FROM audit_logs WHERE action = 'document.support_delete' AND entity_id = $1`, [id])).toBeTruthy();
    expect((await admin.request('DELETE', `/api/support-documents/${id}`)).statusCode).toBe(404);
  });
});
