import { afterAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool.js';
import { createCompany, createSystem, createUser, getApp, loginAs, uid } from './helpers.js';

afterAll(async () => {
  await (await getApp()).close();
  await closePool();
});

describe('Auditoria — tela, pesquisa e alterações de campo', () => {
  it('agrupa por tela, pesquisa por ação/responsável e expõe as alterações de integrações', async () => {
    const admin = await loginAs({ roles: ['admin'] });
    const cs = await createUser({ roles: ['support'] });
    const created = await admin.request('POST', '/api/integrations', { companyId: await createCompany(), systemId: await createSystem(), objective: 'Objetivo A', csGcId: cs.id, description: 'Desc' });
    const id = created.json().integration.id as string;
    await admin.request('PUT', `/api/integrations/${id}`, { version: 1, objective: 'Objetivo B', status: 'acompanhamento' });

    const byScreen = (await admin.request('GET', `/api/audit?screen=${encodeURIComponent('Integração de Clientes')}&entityId=${id}`)).json();
    expect(byScreen.items.length).toBeGreaterThanOrEqual(2);
    expect(byScreen.items.every((i: { screen: string }) => i.screen === 'Integração de Clientes')).toBe(true);
    const update = byScreen.items.find((i: { action: string }) => i.action === 'integration.update');
    expect(update.data.changes).toEqual(expect.arrayContaining([{ field: 'Objetivo', before: 'Objetivo A', after: 'Objetivo B' }, { field: 'Status', before: 'Início', after: 'Acompanhamento' }]));
    expect(byScreen.facets.screens).toContain('Integração de Clientes');
    expect((await admin.request('GET', `/api/audit?screen=Artigos&entityId=${id}`)).json().total).toBe(0);
    // pesquisa livre por responsável (sem acento) e por ação
    const mine = (await admin.request('GET', `/api/audit?q=${encodeURIComponent('integration.upd')}&entityId=${id}`)).json();
    expect(mine.total).toBe(1);
    expect((await admin.request('GET', `/api/audit?q=${encodeURIComponent(admin.name.toUpperCase())}&entityId=${id}`)).json().total).toBeGreaterThanOrEqual(2);
    const reader = await loginAs({ roles: ['internal_reader'] });
    expect((await reader.request('GET', '/api/audit')).statusCode).toBe(403);
    void uid;
  });
});
