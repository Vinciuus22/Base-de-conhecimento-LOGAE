import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closePool, query, queryOne } from '../src/db/pool.js';
import { anonymous, createCompany, createSystem, createUser, getApp, login, loginAs, uid, type Session } from './helpers.js';

afterAll(async () => {
  await (await getApp()).close();
  await closePool();
});

const today = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const addDays = (n: number) => new Date(Date.now() - 3 * 3600_000 + n * 86_400_000).toISOString().slice(0, 10);

async function base(over: Record<string, unknown> = {}) {
  const csUser = await createUser({ roles: ['support'], name: uid('CS ') });
  return {
    companyId: await createCompany(),
    systemId: await createSystem(),
    objective: 'Integrar o sistema do cliente ao TMS',
    csGcId: csUser.id,
    description: 'Contexto inicial.\n- item 1\n- item 2',
    ...over,
  };
}
async function create(s: Session, over: Record<string, unknown> = {}) {
  const res = await s.request('POST', '/api/integrations', await base(over));
  expect(res.statusCode, res.body).toBe(201);
  return res.json().integration as { id: string; version: number; status: string };
}
const changes = (id: string) => query(`SELECT * FROM integration_changes WHERE integration_id = $1 ORDER BY created_at, field_name`, [id]);

describe('Integração de Clientes — acesso', () => {
  it('somente internos autorizados; permissões específicas validadas no backend', async () => {
    const admin = await loginAs({ roles: ['admin'] });
    const card = await create(admin);
    expect((await (await anonymous()).request('GET', '/api/integrations')).statusCode).toBe(401);
    const external = await loginAs({ type: 'external' });
    for (const [m, u] of [['GET', '/api/integrations'], ['GET', `/api/integrations/${card.id}`], ['POST', '/api/integrations'], ['GET', `/api/integrations/${card.id}/changes`], ['GET', '/api/integrations/lookups']] as const) {
      expect((await external.request(m, u, m === 'POST' ? await base() : undefined)).statusCode, `${m} ${u}`).toBe(403);
    }
    const reader = await loginAs({ roles: ['internal_reader'] });
    expect((await reader.request('GET', '/api/integrations')).statusCode).toBe(403);
    // visualizar apenas: não cria, não edita, não registra, não consulta histórico de alterações
    const viewer = await loginAs({ roles: ['internal_reader'], grant: ['integrations.view'] });
    expect((await viewer.request('GET', `/api/integrations/${card.id}`)).statusCode).toBe(200);
    expect((await viewer.request('POST', '/api/integrations', await base())).statusCode).toBe(403);
    expect((await viewer.request('PUT', `/api/integrations/${card.id}`, { version: 1, objective: 'x'.repeat(5) })).statusCode).toBe(403);
    expect((await viewer.request('POST', `/api/integrations/${card.id}/activities`, {})).statusCode).toBe(403);
    expect((await viewer.request('GET', `/api/integrations/${card.id}/changes`)).statusCode).toBe(403);
    expect((await viewer.request('POST', `/api/integrations/${card.id}/finish`, { version: 1, confirm: true, resultSummary: 'ok' })).statusCode).toBe(403);
    expect((await viewer.request('POST', `/api/integrations/${card.id}/reopen`, { version: 1, reason: 'motivo' })).statusCode).toBe(403);
    expect((await viewer.request('POST', `/api/integrations/${card.id}/archive`, { version: 1 })).statusCode).toBe(403);
    const operator = await loginAs({ roles: ['integrations'] });
    expect((await operator.request('POST', `/api/integrations/${card.id}/archive`, { version: 1 })).statusCode).toBe(403);
    expect((await operator.request('DELETE', `/api/integrations/${card.id}/activities/${randomUUID()}`)).statusCode).toBe(403);
    expect((await operator.request('GET', '/api/integrations/00000000-0000-0000-0000-000000000000')).statusCode).toBe(404);
    expect((await operator.request('GET', '/api/integrations/abc')).statusCode).toBe(422);
  });
});

describe('Integração de Clientes — cadastro e edição', () => {
  it('valida obrigatórios, cria com status Início, audita a criação e evita duplicidade por reenvio', async () => {
    const s = await loginAs({ roles: ['integrations'] });
    const full = await base();
    for (const k of ['companyId', 'systemId', 'objective', 'csGcId', 'description']) {
      const body = { ...full } as Record<string, unknown>;
      delete body[k];
      const r = await s.request('POST', '/api/integrations', body);
      expect(r.statusCode, k).toBe(422);
    }
    expect((await s.request('POST', '/api/integrations', { ...full, objective: '   ' })).statusCode).toBe(422);
    expect((await s.request('POST', '/api/integrations', { ...full, status: 'finalizado' })).statusCode).toBe(422);
    expect((await s.request('POST', '/api/integrations', { ...full, startedOn: '2026-10-10', expectedEndOn: '2026-10-01' })).statusCode).toBe(422);
    expect((await s.request('POST', '/api/integrations', { ...full, companyId: randomUUID() })).statusCode).toBe(422);
    const requestId = randomUUID();
    const a = await s.request('POST', '/api/integrations', { ...full, requestId });
    const b = await s.request('POST', '/api/integrations', { ...full, requestId });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json().duplicate).toBe(true);
    expect(b.json().integration.id).toBe(a.json().integration.id);
    const card = a.json().integration;
    expect(card).toMatchObject({ status: 'inicio', version: 1, createdBy: { name: s.name } });
    const ch = await changes(card.id);
    expect(ch.every((c) => c.operation_type === 'create' && c.user_name === s.name && c.old_value === null)).toBe(true);
    expect(ch.map((c) => c.field_name)).toEqual(expect.arrayContaining(['companyId', 'systemId', 'objective', 'csGcId', 'description', 'status']));
    expect(await queryOne(`SELECT 1 FROM audit_logs WHERE action = 'integration.create' AND entity_id = $1`, [card.id])).toBeTruthy();
  });

  it('salva só o que mudou, grava uma linha por campo na mesma operação com usuário/valores e não gera registro sem mudança', async () => {
    const s = await loginAs({ roles: ['integrations'] });
    const other = await createUser({ roles: ['support'], name: 'Novo Operador' });
    const card = await create(s);
    const noop = await s.request('PUT', `/api/integrations/${card.id}`, { version: card.version, objective: 'Integrar o sistema do cliente ao TMS' });
    expect(noop.json()).toMatchObject({ changed: false });
    expect(noop.json().integration.version).toBe(1);
    // formulário completo com campos vazios (null) não pode gerar registros para o que não mudou
    const full = await s.request('PUT', `/api/integrations/${card.id}`, { version: 1, operatorId: null, startedOn: null, expectedEndOn: null, nextAction: null, nextActionOwnerId: null, nextActionDue: null, nextActionNotes: null, notes: null, objective: 'Integrar o sistema do cliente ao TMS' });
    expect(full.json()).toMatchObject({ changed: false });
    expect((await changes(card.id)).some((c) => c.old_value === null && c.new_value === null)).toBe(false);
    const before = (await changes(card.id)).length;
    const res = await s.request('PUT', `/api/integrations/${card.id}`, { version: 1, objective: 'Novo objetivo', operatorId: other.id, nextAction: 'Reunião de validação', nextActionDue: addDays(3), status: 'acompanhamento' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().integration).toMatchObject({ version: 2, status: 'acompanhamento', operator: { name: 'Novo Operador' } });
    const rows = (await changes(card.id)).slice(before);
    expect(rows.map((r) => r.field_name).sort()).toEqual(['nextAction', 'nextActionDue', 'objective', 'operatorId', 'status']);
    expect(new Set(rows.map((r) => r.operation_id)).size).toBe(1);
    expect(rows.every((r) => r.user_id === s.userId && r.user_name === s.name && r.created_at)).toBe(true);
    expect(rows.find((r) => r.field_name === 'objective')).toMatchObject({ old_value: 'Integrar o sistema do cliente ao TMS', new_value: 'Novo objetivo' });
    expect(rows.find((r) => r.field_name === 'status')).toMatchObject({ old_value: 'Início', new_value: 'Acompanhamento', operation_type: 'status_change' });
    expect(rows.find((r) => r.field_name === 'operatorId')).toMatchObject({ old_value: null, new_value: 'Novo Operador' });
    // consulta do histórico
    const hist = (await s.request('GET', `/api/integrations/${card.id}/changes?field=status`)).json();
    expect(hist.items.map((i: { field: string }) => i.field)).toEqual(['status', 'status']); // criação + alteração
    expect(hist.facets.users).toContain(s.name);
  });

  it('proíbe finalizar/reabrir pela edição e exige permissão de status', async () => {
    const admin = await loginAs({ roles: ['admin'] });
    const editorOnly = await loginAs({ roles: ['internal_reader'], grant: ['integrations.view', 'integrations.edit'] });
    const card = await create(admin);
    expect((await admin.request('PUT', `/api/integrations/${card.id}`, { version: 1, status: 'finalizado' })).statusCode).toBe(422);
    expect((await editorOnly.request('PUT', `/api/integrations/${card.id}`, { version: 1, status: 'acompanhamento' })).statusCode).toBe(403);
    expect((await editorOnly.request('PUT', `/api/integrations/${card.id}`, { version: 1, notes: 'obs' })).statusCode).toBe(200);
  });

  it('detecta edição concorrente (409 com dados atuais) sem sobrescrever e sem registrar auditoria', async () => {
    const a = await loginAs({ roles: ['integrations'] });
    const b = await loginAs({ roles: ['integrations'] });
    const card = await create(a);
    expect((await a.request('PUT', `/api/integrations/${card.id}`, { version: 1, notes: 'da pessoa A' })).statusCode).toBe(200);
    const stale = await b.request('PUT', `/api/integrations/${card.id}`, { version: 1, notes: 'da pessoa B', objective: 'Objetivo B' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error?.code ?? stale.json().code).toBe('VERSION_CONFLICT');
    const details = stale.json().error?.details ?? stale.json().details;
    expect(details.current).toMatchObject({ version: 2, notes: 'da pessoa A' });
    const row = await queryOne(`SELECT notes, objective, version FROM customer_integrations WHERE id = $1`, [card.id]);
    expect(row).toMatchObject({ notes: 'da pessoa A', version: 2 });
    expect((await changes(card.id)).some((c) => c.new_value === 'Objetivo B')).toBe(false);
    expect((await b.request('PUT', `/api/integrations/${card.id}`, { version: 2, notes: 'da pessoa B' })).statusCode).toBe(200);
    // ações de status também respeitam a versão
    expect((await b.request('POST', `/api/integrations/${card.id}/finish`, { version: 1, confirm: true, resultSummary: 'ok' })).statusCode).toBe(409);
  });

  it('é transacional: se a gravação do histórico falhar, o card não é alterado', async () => {
    const s = await loginAs({ roles: ['integrations'] });
    const card = await create(s);
    await query(`CREATE OR REPLACE FUNCTION t_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.new_value = 'FALHA-FORCADA' THEN RAISE EXCEPTION 'falha simulada'; END IF; RETURN NEW; END$$`);
    await query(`CREATE TRIGGER t_fail_audit BEFORE INSERT ON integration_changes FOR EACH ROW EXECUTE FUNCTION t_fail_audit()`);
    try {
      const res = await s.request('PUT', `/api/integrations/${card.id}`, { version: 1, notes: 'FALHA-FORCADA' });
      expect(res.statusCode).toBe(500);
    } finally {
      await query(`DROP TRIGGER t_fail_audit ON integration_changes`);
    }
    expect(await queryOne(`SELECT notes, version FROM customer_integrations WHERE id = $1`, [card.id])).toMatchObject({ notes: null, version: 1 });
  });

  it('o histórico de alterações é imutável (UPDATE/DELETE bloqueados)', async () => {
    const s = await loginAs({ roles: ['integrations'] });
    const card = await create(s);
    await expect(query(`UPDATE integration_changes SET new_value = 'x' WHERE integration_id = $1`, [card.id])).rejects.toThrow(/imutáveis/);
    await expect(query(`DELETE FROM integration_changes WHERE integration_id = $1`, [card.id])).rejects.toThrow(/imutáveis/);
    // não há rota para alterar/excluir o histórico
    expect((await s.request('DELETE', `/api/integrations/${card.id}/changes`)).statusCode).toBe(404);
    expect((await s.request('PUT', `/api/integrations/${card.id}/changes`, {})).statusCode).toBe(404);
  });
});

describe('Integração de Clientes — atividades', () => {
  it('registra atividades sem sobrescrever, com autor/data do backend, em ordem cronológica; admin corrige/remove com auditoria', async () => {
    const s = await loginAs({ roles: ['integrations'] });
    const admin = await loginAs({ roles: ['admin'] });
    const card = await create(s);
    const types = (await s.request('GET', '/api/integrations/lookups')).json().activityTypes as Array<{ id: string; name: string }>;
    expect(types.map((t) => t.name)).toEqual(expect.arrayContaining(['Reunião', 'Teste de integração', 'Pendência identificada']));
    const meeting = types.find((t) => t.name === 'Reunião')!;
    expect((await s.request('POST', `/api/integrations/${card.id}/activities`, { typeId: meeting.id })).statusCode).toBe(422);
    expect((await s.request('POST', `/api/integrations/${card.id}/activities`, { typeId: randomUUID(), description: 'x' })).statusCode).toBe(422);
    const first = await s.request('POST', `/api/integrations/${card.id}/activities`, { typeId: meeting.id, description: 'Reunião inicial', outcome: 'Requisitos levantados', authorId: randomUUID(), authorName: 'Fraudador', createdAt: '2001-01-01T00:00:00Z' });
    expect(first.statusCode).toBe(201);
    expect(first.json().activity).toMatchObject({ author: s.name, authorId: s.userId, type: 'Reunião' });
    expect(new Date(first.json().activity.createdAt).getFullYear()).toBeGreaterThan(2020);
    await s.request('POST', `/api/integrations/${card.id}/activities`, { typeId: meeting.id, description: 'Segunda reunião', nextAction: 'Validar', nextActionDue: addDays(2) });
    const asc = (await s.request('GET', `/api/integrations/${card.id}/activities?order=asc`)).json();
    expect(asc.items.map((a: { description: string }) => a.description)).toEqual(['Reunião inicial', 'Segunda reunião']);
    expect((await s.request('GET', `/api/integrations/${card.id}/activities?order=desc`)).json().items[0].description).toBe('Segunda reunião');
    expect((await queryOne<{ version: number }>(`SELECT version FROM customer_integrations WHERE id = $1`, [card.id]))!.version).toBe(1); // atividade não conflita com edição

    const id1 = first.json().activity.id as string;
    expect((await s.request('PUT', `/api/integrations/${card.id}/activities/${id1}`, { typeId: meeting.id, description: 'x' })).statusCode).toBe(403);
    expect((await admin.request('PUT', `/api/integrations/${card.id}/activities/${id1}`, { typeId: meeting.id, description: 'Reunião inicial (corrigida)', outcome: 'Requisitos levantados' })).statusCode).toBe(200);
    expect((await changes(card.id)).find((c) => c.field_name === 'activity.description')).toMatchObject({ old_value: 'Reunião inicial', new_value: 'Reunião inicial (corrigida)', operation_type: 'activity_edit', user_name: admin.name });
    expect((await admin.request('DELETE', `/api/integrations/${card.id}/activities/${id1}`)).statusCode).toBe(200);
    expect((await s.request('GET', `/api/integrations/${card.id}/activities`)).json().total).toBe(1);
    expect((await changes(card.id)).some((c) => c.operation_type === 'activity_delete' && c.old_value?.includes('Reunião inicial (corrigida)'))).toBe(true);
    // tipos configuráveis
    const created = await admin.request('POST', '/api/integrations/activity-types', { name: uid('Tipo ') });
    expect(created.statusCode).toBe(201);
    expect((await s.request('POST', '/api/integrations/activity-types', { name: 'Outro' })).statusCode).toBe(403);
  });
});

describe('Integração de Clientes — finalização, reabertura e arquivamento', () => {
  it('finaliza com confirmação, preserva tudo, reabre com motivo e mantém a finalização anterior no histórico', async () => {
    const s = await loginAs({ roles: ['integrations'] });
    const admin = await loginAs({ roles: ['admin'] });
    const card = await create(s);
    const types = (await s.request('GET', '/api/integrations/lookups')).json().activityTypes as Array<{ id: string }>;
    await s.request('POST', `/api/integrations/${card.id}/activities`, { typeId: types[0]!.id, description: 'Atividade antes de finalizar' });
    expect((await s.request('POST', `/api/integrations/${card.id}/finish`, { version: 1, resultSummary: 'ok' })).statusCode).toBe(422); // sem confirmação
    expect((await s.request('POST', `/api/integrations/${card.id}/finish`, { version: 1, confirm: true })).statusCode).toBe(422); // sem resumo
    const fin = await s.request('POST', `/api/integrations/${card.id}/finish`, { version: 1, confirm: true, finishedOn: today(), resultSummary: 'Integração concluída', finalNotes: 'Sem observações', remainingPending: 'Nenhuma' });
    expect(fin.statusCode, fin.body).toBe(200);
    expect(fin.json().integration).toMatchObject({ status: 'finalizado', finishedOn: today(), resultSummary: 'Integração concluída', finishedBy: { name: s.name }, version: 2 });
    expect((await s.request('GET', `/api/integrations/${card.id}/activities`)).json().total).toBe(1);
    expect((await s.request('POST', `/api/integrations/${card.id}/finish`, { version: 2, confirm: true, resultSummary: 'x' })).statusCode).toBe(409);
    // reabrir exige permissão e motivo
    expect((await s.request('POST', `/api/integrations/${card.id}/reopen`, { version: 2, reason: 'Cliente pediu ajuste' })).statusCode).toBe(403);
    expect((await admin.request('POST', `/api/integrations/${card.id}/reopen`, { version: 2 })).statusCode).toBe(422);
    const re = await admin.request('POST', `/api/integrations/${card.id}/reopen`, { version: 2, reason: 'Cliente pediu ajuste', status: 'acompanhamento' });
    expect(re.statusCode, re.body).toBe(200);
    expect(re.json().integration).toMatchObject({ status: 'acompanhamento', finishedOn: null, version: 3 });
    const ch = await changes(card.id);
    expect(ch.filter((c) => c.operation_type === 'finish').map((c) => c.field_name).sort()).toEqual(expect.arrayContaining(['finalNotes', 'finishedOn', 'remainingPending', 'resultSummary', 'status']));
    expect(ch.find((c) => c.operation_type === 'reopen' && c.field_name === 'finishedOn')).toMatchObject({ old_value: today(), new_value: null, user_name: admin.name });
    expect(ch.find((c) => c.operation_type === 'reopen' && c.field_name === 'resultSummary')).toMatchObject({ old_value: 'Integração concluída' });
    expect(ch.find((c) => c.field_name === 'reopenReason')?.new_value).toBe('Cliente pediu ajuste');
    expect(await queryOne(`SELECT 1 FROM audit_logs WHERE action = 'integration.reopen' AND entity_id = $1`, [card.id])).toBeTruthy();
    expect((await admin.request('POST', `/api/integrations/${card.id}/reopen`, { version: 3, reason: 'de novo' })).statusCode).toBe(409);
  });

  it('arquivar oculta da listagem, bloqueia edição e restaurar volta ao normal', async () => {
    const admin = await loginAs({ roles: ['admin'] });
    const card = await create(admin, { objective: uid('Objetivo arquivável ') });
    const arch = await admin.request('POST', `/api/integrations/${card.id}/archive`, { version: 1 });
    expect(arch.statusCode).toBe(200);
    expect(arch.json().integration.archived).toBe(true);
    const ids = async (qs = '') => ((await admin.request('GET', `/api/integrations?pageSize=100${qs}`)).json().items as Array<{ id: string }>).map((i) => i.id);
    expect(await ids()).not.toContain(card.id);
    expect(await ids('&archived=1')).toContain(card.id);
    expect((await admin.request('PUT', `/api/integrations/${card.id}`, { version: 2, notes: 'x' })).statusCode).toBe(409);
    expect((await admin.request('POST', `/api/integrations/${card.id}/restore`, { version: 2 })).statusCode).toBe(200);
    expect(await ids()).toContain(card.id);
    expect((await changes(card.id)).map((c) => c.operation_type)).toEqual(expect.arrayContaining(['archive', 'restore']));
  });
});

describe('Integração de Clientes — listagem, filtros e indicadores', () => {
  it('pesquisa sem acento, filtros combináveis, ordenação, paginação e indicadores reais', async () => {
    const s = await loginAs({ roles: ['admin'] });
    const tag = uid('Zq').replace(/\s/g, '');
    const cNorte = await createCompany(`Transportes Açaí ${tag}`);
    const cSul = await createCompany(`Logística Sul ${tag}`);
    const sysA = await createSystem(`TMS Alfa ${tag}`);
    const sysB = await createSystem(`TMS Beta ${tag}`);
    const a = await create(s, { companyId: cNorte, systemId: sysA, nextAction: 'Reunião', nextActionDue: addDays(-2), expectedEndOn: addDays(10) });
    const b = await create(s, { companyId: cSul, systemId: sysB, nextAction: 'Teste', nextActionDue: addDays(5), expectedEndOn: addDays(3) });
    const c = await create(s, { companyId: cSul, systemId: sysA, expectedEndOn: addDays(20) });
    await s.request('PUT', `/api/integrations/${b.id}`, { version: 1, status: 'acompanhamento' });
    await s.request('POST', `/api/integrations/${c.id}/finish`, { version: 1, confirm: true, resultSummary: 'ok' });
    const list = async (qs: string) => (await s.request('GET', `/api/integrations?${qs}`)).json() as { total: number; items: Array<{ id: string; status: string; overdue: boolean; company: { name: string } }>; stats: Record<string, number> };
    const idsOf = (r: { items: Array<{ id: string }> }) => r.items.map((i) => i.id);
    expect(idsOf(await list(`q=${encodeURIComponent(`acai ${tag}`)}`))).toEqual([a.id]); // sem acento
    expect(idsOf(await list(`q=${encodeURIComponent(`TMS BETA ${tag}`)}`))).toEqual([b.id]);
    expect((await list(`q=${tag}&sort=company&dir=asc`)).items.map((i) => i.company.name)[0]).toContain('Logística');
    expect(idsOf(await list(`q=${tag}&status=acompanhamento`))).toEqual([b.id]);
    expect(new Set(idsOf(await list(`q=${tag}&status=inicio,finalizado`)))).toEqual(new Set([a.id, c.id]));
    expect(idsOf(await list(`q=${tag}&companyId=${cSul}&systemId=${sysA}`))).toEqual([c.id]);
    expect(idsOf(await list(`q=${tag}&overdue=1`))).toEqual([a.id]); // só vencida e não finalizada
    expect((await list(`q=${tag}&overdue=1`)).items[0]!.overdue).toBe(true);
    expect(idsOf(await list(`q=${tag}&sort=expected&dir=asc`))).toEqual([b.id, a.id, c.id]);
    expect(idsOf(await list(`q=${tag}&expectedFrom=${addDays(15)}`))).toEqual([c.id]);
    expect(idsOf(await list(`q=${tag}&createdFrom=${today()}&createdTo=${addDays(1)}`)).length).toBe(3);
    expect((await list(`q=${tag}&createdTo=2020-01-01`)).total).toBe(0);
    const page2 = await list(`q=${tag}&pageSize=2&page=2`);
    expect(page2.total).toBe(3);
    expect(page2.items).toHaveLength(1);
    const stats = (await list('')).stats;
    const real = await queryOne<Record<string, number>>(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status='inicio')::int AS inicio, count(*) FILTER (WHERE status='acompanhamento')::int AS acompanhamento, count(*) FILTER (WHERE status='finalizado')::int AS finalizado FROM customer_integrations WHERE archived_at IS NULL`);
    expect(stats).toMatchObject(real!);
    expect(stats.overdue).toBeGreaterThanOrEqual(1);
    expect((await s.request('GET', '/api/integrations?status=invalido')).statusCode).toBe(422);
  });
});
