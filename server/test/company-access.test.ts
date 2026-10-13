import { afterAll, describe, expect, it } from 'vitest';
import { closePool, queryOne } from '../src/db/pool.js';
import { createCompany, createSystem, createUser, getApp, login, loginAs, pngBuffer } from './helpers.js';

afterAll(async () => {
  await (await getApp()).close();
  await closePool();
});

describe('Empresas — acesso multi-empresa e sistemas contratados', () => {
  it('somente quem gerencia usuários vê e altera acessos e sistemas', async () => {
    const reader = await loginAs({ roles: ['internal_reader'] });
    const company = await createCompany();
    const user = await createUser({ type: 'external' });
    for (const [m, u, b] of [
      ['GET', '/api/companies/overview', undefined],
      ['GET', `/api/users/${user.id}/company-access`, undefined],
      ['PUT', `/api/users/${user.id}/company-access`, { companyIds: [company] }],
      ['PUT', `/api/companies/${company}/systems`, { systemIds: [] }],
    ] as const) expect((await reader.request(m, u, b)).statusCode, `${m} ${u}`).toBe(403);
  });

  it('concede/revoga acesso a empresas com auditoria (antes/depois) e estende "tickets da empresa"', async () => {
    const admin = await loginAs({ roles: ['admin'] });
    const [a, b] = [await createCompany('Empresa A '), await createCompany('Empresa B ')];
    const cliente = await createUser({ type: 'external', companyId: a, grant: ['tickets.view_company'] });
    const colega = await createUser({ type: 'external', companyId: b });
    const sysId = await createSystem();
    // ticket aberto por usuário da empresa B
    const sColega = await login(colega);
    const t = await sColega.multipart('POST', '/api/tickets', {
      fields: { title: 'Ticket da empresa B', description: 'Ao clicar em emitir, aparece a mensagem de erro 500 e nada acontece.', systemId: sysId },
      files: [{ filename: 'erro.png', content: await pngBuffer(), contentType: 'image/png' }],
    });
    expect(t.statusCode, t.body).toBe(201);

    const sCliente = await login(cliente);
    const before = (await sCliente.request('GET', '/api/tickets/mine?scope=company')).json();
    expect(before.items.map((i: { title: string }) => i.title)).not.toContain('Ticket da empresa B');

    const put = await admin.request('PUT', `/api/users/${cliente.id}/company-access`, { companyIds: [a, b] });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().companyIds).toEqual([b]); // a é a empresa principal
    expect((await admin.request('GET', `/api/users/${cliente.id}/company-access`)).json()).toMatchObject({ primary: { id: a }, companyIds: [b] });
    const after = (await sCliente.request('GET', '/api/tickets/mine?scope=company')).json();
    expect(after.items.map((i: { title: string }) => i.title)).toContain('Ticket da empresa B');
    const ticketId = after.items.find((i: { title: string }) => i.title === 'Ticket da empresa B').id;
    expect((await sCliente.request('GET', `/api/tickets/${ticketId}`)).statusCode).toBe(200);

    const log = await queryOne<{ data: { changes: Array<{ field: string; before: string | null; after: string }> } }>(`SELECT data FROM audit_logs WHERE action = 'company.access_update' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [cliente.id]);
    expect(log!.data.changes[0]).toMatchObject({ field: 'Empresas com acesso', before: null });
    expect(log!.data.changes[0]!.after).toContain('Empresa B');

    // revogar
    await admin.request('PUT', `/api/users/${cliente.id}/company-access`, { companyIds: [] });
    expect((await sCliente.request('GET', `/api/tickets/${ticketId}`)).statusCode).toBe(404);
    expect((await admin.request('PUT', `/api/users/${cliente.id}/company-access`, { companyIds: ['00000000-0000-0000-0000-000000000000'] })).statusCode).toBe(422);
  });

  it('sistemas contratados por empresa e visão geral', async () => {
    const admin = await loginAs({ roles: ['admin'] });
    const company = await createCompany('Contratante ');
    const [s1, s2] = [await createSystem('Sis X '), await createSystem('Sis Y ')];
    expect((await admin.request('PUT', `/api/companies/${company}/systems`, { systemIds: [s1, s2] })).statusCode).toBe(200);
    const overview = (await admin.request('GET', '/api/companies/overview')).json().items.find((c: { id: string }) => c.id === company);
    expect(overview.systems).toHaveLength(2);
    expect((await admin.request('PUT', `/api/companies/${company}/systems`, { systemIds: [s2] })).statusCode).toBe(200);
    expect((await admin.request('GET', '/api/companies/overview')).json().items.find((c: { id: string }) => c.id === company).systems).toHaveLength(1);
    expect((await admin.request('PUT', `/api/companies/${company}/systems`, { systemIds: ['00000000-0000-0000-0000-000000000000'] })).statusCode).toBe(422);
  });
});
