import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config, setConfig } from '../src/config.js';
import { closePool, query, queryOne } from '../src/db/pool.js';
import { setJiraFetch } from '../src/modules/updates/jira.js';
import { setSleep } from '../src/modules/cards/service.js';
import { anonymous, getApp, loginAs } from './helpers.js';

const SECRET = 'segredo-de-teste-do-jira';
const BASE = 'https://exemplo.atlassian.net';
let seq = Math.floor(Math.random() * 1e6) + 1000;
const nextKey = (p = 'CHL') => `${p}-${seq++}`;

beforeEach(() => setSleep(async () => {}));
afterAll(async () => {
  setJiraFetch(null);
  setSleep(null);
  await (await getApp()).close();
  await closePool();
});

const user = (name: string, id = `acc-${name}`) => ({ displayName: name, accountId: id });
function issue(key: string, over: { summary?: string; status?: string; assignee?: string | null; description?: string; updated?: string } = {}) {
  return {
    id: String(seq++ + 5000),
    key,
    fields: {
      summary: over.summary ?? `Card ${key}`,
      description: over.description ?? 'Descrição inicial',
      status: { name: over.status ?? '01 - Para Desenvolver', statusCategory: { key: 'new' } },
      assignee: over.assignee === null ? null : user(over.assignee ?? 'Maria Souza'),
      reporter: user('Relator Jira'),
      priority: { name: 'Alta' },
      issuetype: { name: 'Task' },
      project: { key: key.split('-')[0], name: key.startsWith('CHL') ? 'Chamados' : 'Riscos' },
      created: '2026-10-01T10:00:00.000+0000',
      updated: over.updated ?? '2026-10-05T10:00:00.000+0000',
    },
  };
}
const statusHistory = (id: number, from: string, to: string, author = user('Carlos Lima'), created = '2026-10-02T12:00:00.000+0000') => ({
  id: String(id), author, created, items: [{ field: 'status', fromString: from, toString: to }],
});

async function hook(body: unknown, secret: string | null = SECRET) {
  const app = await getApp();
  return app.inject({ method: 'POST', url: '/api/integrations/jira/cards/webhook', headers: secret ? { 'x-jira-secret': secret } : {}, payload: body as object });
}
const events = async (key: string) =>
  query(`SELECT e.* FROM jira_card_events e JOIN jira_cards c ON c.id = e.card_id WHERE c.card_key = $1 ORDER BY e.occurred_at`, [key]);

describe('Atualizações dos Cards — acesso', () => {
  it('somente internos com cards.view acessam; sincronizar exige cards.sync', async () => {
    const k = nextKey();
    await hook({ webhookEvent: 'jira:issue_created', timestamp: 1, issue: issue(k) });
    expect((await (await anonymous()).request('GET', '/api/cards')).statusCode).toBe(401);
    const external = await loginAs({ type: 'external' });
    expect((await external.request('GET', '/api/cards')).statusCode).toBe(403);
    expect((await external.request('GET', `/api/cards/${k}`)).statusCode).toBe(403);
    expect((await external.request('GET', `/api/cards/${k}/events`)).statusCode).toBe(403);
    const reader = await loginAs({ roles: ['internal_reader'] });
    expect((await reader.request('GET', '/api/cards')).statusCode).toBe(403);
    const support = await loginAs({ roles: ['support'] });
    expect((await support.request('GET', '/api/cards')).statusCode).toBe(200);
    expect((await support.request('POST', '/api/cards/sync')).statusCode).toBe(403);
    // O módulo é somente leitura: não há rotas de alteração
    expect((await support.request('PUT', `/api/cards/${k}`, { title: 'x' })).statusCode).toBe(404);
    expect((await support.request('POST', `/api/cards/${k}/comments`, { body: 'x' })).statusCode).toBe(404);
  });
});

describe('Atualizações dos Cards — webhook', () => {
  it('rejeita segredo ausente/incorreto e payload sem card', async () => {
    expect((await hook({ issue: issue(nextKey()) }, null)).statusCode).toBe(401);
    expect((await hook({ issue: issue(nextKey()) }, 'errado')).statusCode).toBe(401);
    expect((await hook({})).statusCode).toBe(400);
  });

  it('registra mudança de status com valor anterior/novo, autor e responsável atual separados', async () => {
    setJiraFetch(null);
    const k = nextKey();
    const res = await hook({
      webhookEvent: 'jira:issue_updated', timestamp: 100, issue: issue(k, { status: 'PRONTO', assignee: 'Ana Responsável' }),
      changelog: statusHistory(9001, 'Em Desenvolvimento', 'PRONTO', user('Carlos Lima', 'acc-carlos')),
    });
    expect(res.json()).toEqual({ ok: true, result: 'processed' });
    const support = await loginAs({ roles: ['support'] });
    const card = (await support.request('GET', `/api/cards/${k}`)).json().card;
    expect(card).toMatchObject({ key: k, status: 'PRONTO', assignee: 'Ana Responsável', lastEventType: 'status_change', lastEventAuthor: 'Carlos Lima', projectKey: 'CHL', url: `${BASE}/browse/${k}` });
    const list = (await support.request('GET', `/api/cards/${k}/events`)).json();
    const change = list.items.find((e: { type: string }) => e.type === 'status_change');
    expect(change).toMatchObject({ field: 'status', from: 'Em Desenvolvimento', to: 'PRONTO', author: 'Carlos Lima', authorAccountId: 'acc-carlos', jiraEventId: '9001' });
    expect(change.summary).toContain('Em Desenvolvimento → PRONTO');
    expect(list.items.some((e: { type: string }) => e.type === 'card_created')).toBe(true);
  });

  it('é idempotente: reenvio do mesmo evento não duplica', async () => {
    const k = nextKey();
    const body = { webhookEvent: 'jira:issue_updated', timestamp: 200, issue: issue(k), changelog: statusHistory(9100, 'A', 'B') };
    expect((await hook(body)).json().result).toBe('processed');
    expect((await hook(body)).json().result).toBe('duplicate');
    // mesmo changelog chegando por outro webhook (timestamp diferente) também não duplica
    await hook({ ...body, timestamp: 201 });
    expect((await events(k)).filter((e) => e.event_type === 'status_change')).toHaveLength(1);
  });

  it('registra comentários (e edição) sem notificar ninguém; comentário restrito não replica o conteúdo', async () => {
    const k = nextKey();
    const adf = (t: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
    await hook({ webhookEvent: 'comment_created', timestamp: 300, issue: issue(k), comment: { id: '77', author: user('Pedro'), body: adf('Precisa de ajuste no relatório'), created: '2026-10-03T09:00:00.000+0000', updated: '2026-10-03T09:00:00.000+0000' } });
    await hook({ webhookEvent: 'comment_created', timestamp: 301, issue: issue(k), comment: { id: '78', author: user('Pedro'), body: adf('Segredo restrito'), created: '2026-10-03T10:00:00.000+0000', updated: '2026-10-03T10:00:00.000+0000', visibility: { type: 'group', value: 'gestores' } } });
    await hook({ webhookEvent: 'comment_updated', timestamp: 302, issue: issue(k), comment: { id: '77', author: user('Pedro'), body: adf('Precisa de ajuste no relatório mensal'), created: '2026-10-03T09:00:00.000+0000', updated: '2026-10-04T09:00:00.000+0000' } });
    const ev = await events(k);
    expect(ev.find((e) => e.event_key === 'cm:77')?.comment_text).toBe('Precisa de ajuste no relatório');
    expect(ev.find((e) => e.event_key === 'cm:78')).toMatchObject({ comment_restricted: true, comment_text: null });
    expect(ev.some((e) => e.event_type === 'comment_edited')).toBe(true);
    expect(JSON.stringify(ev)).not.toContain('Segredo restrito');
    // nenhuma tabela de notificações é tocada por este módulo
    expect(await queryOne(`SELECT 1 FROM information_schema.tables WHERE table_name = 'notifications'`)).toBeNull();
  });

  it('ignora projetos não monitorados', async () => {
    const k = nextKey('OUTRO');
    expect((await hook({ webhookEvent: 'jira:issue_updated', timestamp: 400, issue: issue(k) })).json().result).toBe('ignored');
    expect(await queryOne(`SELECT 1 FROM jira_cards WHERE card_key = $1`, [k])).toBeNull();
  });

  it('webhook parcial não apaga responsável/descrição já sincronizados e card removido preserva dados', async () => {
    const k = nextKey();
    await hook({ webhookEvent: 'jira:issue_created', timestamp: 500, issue: issue(k, { assignee: 'Ana', description: 'Texto original' }) });
    const partial = { id: 'x', key: k, fields: { summary: 'Novo título', status: { name: 'Em Code Review' }, updated: '2026-10-06T10:00:00.000+0000' } };
    await hook({ webhookEvent: 'jira:issue_updated', timestamp: 501, issue: partial });
    const row = await queryOne(`SELECT * FROM jira_cards WHERE card_key = $1`, [k]);
    expect(row).toMatchObject({ title: 'Novo título', status: 'Em Code Review', assignee_name: 'Ana', description: 'Texto original' });
    await hook({ webhookEvent: 'jira:issue_deleted', timestamp: 502, issue: partial });
    expect((await queryOne<{ history_note: string }>(`SELECT history_note FROM jira_cards WHERE card_key = $1`, [k]))?.history_note).toContain('removido');
  });
});

describe('Atualizações dos Cards — sincronização com a API', () => {
  /** Jira simulado: lista de issues + changelog/comentários paginados (2 por página). */
  function fakeJira(opts: { issues: ReturnType<typeof issue>[]; histories?: Record<string, unknown[]>; comments?: Record<string, unknown[]>; failFirst?: number; failComments?: string }) {
    const calls: string[] = [];
    let failures = opts.failFirst ?? 0;
    setJiraFetch(async (url) => {
      calls.push(url);
      const path = url.replace(BASE, '');
      if (failures > 0) {
        failures--;
        return { ok: false, status: 503, json: async () => ({}) };
      }
      if (path.startsWith('/rest/agile')) return { ok: true, status: 200, json: async () => ({ values: [{ name: 'Quadro CHL' }] }) };
      if (path.startsWith('/rest/api/3/search/jql')) return { ok: true, status: 200, json: async () => ({ issues: opts.issues, isLast: true }) };
      const m = /\/issue\/([^/]+)\/(changelog|comment)\?.*startAt=(\d+)/.exec(path)!;
      const [, key, kind, start] = m;
      const items = ((kind === 'changelog' ? opts.histories : opts.comments)?.[key!] ?? []) as unknown[];
      if (kind === 'comment' && opts.failComments === key) return { ok: false, status: 403, json: async () => ({}) };
      const page = items.slice(Number(start), Number(start) + 2);
      return { ok: true, status: 200, json: async () => (kind === 'changelog' ? { values: page, total: items.length, isLast: Number(start) + 2 >= items.length } : { comments: page, total: items.length }) };
    });
    return calls;
  }

  it('recupera histórico paginado completo, quadro e eventos de comentários; repetir a sincronização não duplica', async () => {
    const admin = await loginAs({ roles: ['admin'] });
    const k = nextKey();
    const calls = fakeJira({
      issues: [issue(k, { status: 'Para Deploy' })],
      histories: { [k]: [1, 2, 3, 4, 5].map((i) => statusHistory(7000 + i, `S${i}`, `S${i + 1}`, user('Carlos'), `2026-10-0${i}T12:00:00.000+0000`)) },
      comments: { [k]: [{ id: '1', author: user('Ana'), body: 'texto simples', created: '2026-10-02T08:00:00.000+0000', updated: '2026-10-02T08:00:00.000+0000' }] },
    });
    const res = await admin.request('POST', '/api/cards/sync', { full: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'full', status: 'success' });
    expect((await events(k)).filter((e) => e.event_type === 'status_change')).toHaveLength(5);
    expect(calls.filter((u) => u.includes(`/issue/${k}/changelog`))).toHaveLength(3); // paginação 2+2+1
    expect(calls.some((u) => /project\+in\+%28CHL%2CRISK1%29|project in \(CHL,RISK1\)/.test(decodeURIComponent(u).replace(/\+/g, ' ')))).toBe(true);
    const card = await queryOne(`SELECT * FROM jira_cards WHERE card_key = $1`, [k]);
    expect(card).toMatchObject({ board_name: 'Quadro CHL', history_complete: true, status: 'Para Deploy' });
    const before = (await events(k)).length;
    await admin.request('POST', '/api/cards/sync', { full: true });
    expect((await events(k)).length).toBe(before);
    // somente leitura: a integração nunca chama métodos de escrita (o cliente só faz GET)
  });

  it('retenta falhas temporárias (HTTP 5xx) e conclui', async () => {
    const admin = await loginAs({ roles: ['admin'] });
    const k = nextKey('RISK1');
    fakeJira({ issues: [issue(k)], failFirst: 2 });
    const res = await admin.request('POST', '/api/cards/sync', { full: true });
    expect(res.json().status).toBe('success');
    expect(await queryOne(`SELECT 1 FROM jira_cards WHERE card_key = $1`, [k])).toBeTruthy();
  });

  it('falha total mantém os dados locais, registra o erro e marca a integração como falha', async () => {
    const admin = await loginAs({ roles: ['admin'] });
    const k = nextKey();
    await hook({ webhookEvent: 'jira:issue_created', timestamp: 900, issue: issue(k) });
    setJiraFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    const res = await admin.request('POST', '/api/cards/sync', { full: true });
    expect(res.json()).toMatchObject({ status: 'failed' });
    expect(res.json().errors[0]).toContain('autenticação');
    expect(await queryOne(`SELECT 1 FROM jira_cards WHERE card_key = $1`, [k])).toBeTruthy();
    const status = (await admin.request('GET', '/api/cards/sync-status')).json();
    expect(status).toMatchObject({ state: 'failed', stale: true });
    expect(status.lastRun.error).toContain('autenticação');
    expect(JSON.stringify(status)).not.toContain('token-de-teste');
  });

  it('falha ao recuperar comentários de um card marca o histórico como incompleto, sem afetar os demais', async () => {
    const admin = await loginAs({ roles: ['admin'] });
    const bad = nextKey();
    const good = nextKey();
    fakeJira({ issues: [issue(bad), issue(good)], failComments: bad });
    const res = await admin.request('POST', '/api/cards/sync', { full: true });
    expect(res.json().status).toBe('partial');
    expect(await queryOne(`SELECT history_complete, history_note FROM jira_cards WHERE card_key = $1`, [bad])).toMatchObject({ history_complete: false });
    expect(await queryOne(`SELECT history_complete FROM jira_cards WHERE card_key = $1`, [good])).toMatchObject({ history_complete: true });
    const detail = (await admin.request('GET', `/api/cards/${bad}`)).json().card;
    expect(detail.historyComplete).toBe(false);
    expect(detail.historyNote).toContain('Comentários incompletos');
  });

  it('usa consulta incremental após uma sincronização bem-sucedida e não roda duas ao mesmo tempo', async () => {
    const admin = await loginAs({ roles: ['admin'] });
    fakeJira({ issues: [] });
    await admin.request('POST', '/api/cards/sync', { full: true });
    const calls = fakeJira({ issues: [] });
    const res = await admin.request('POST', '/api/cards/sync');
    expect(res.json().kind).toBe('incremental');
    expect(decodeURIComponent(calls.find((u) => u.includes('search/jql'))!).replace(/\+/g, ' ')).toMatch(/updated >= -\d+m/);
  });

  it('sem Jira configurado a sincronização manual informa o motivo (503)', async () => {
    const admin = await loginAs({ roles: ['admin'] });
    const original = config();
    setConfig({ ...original, JIRA_API_TOKEN: undefined });
    try {
      const res = await admin.request('POST', '/api/cards/sync');
      expect(res.statusCode).toBe(503);
      expect(res.json().error?.code ?? res.json().code).toBe('JIRA_NOT_CONFIGURED');
    } finally {
      setConfig(original);
    }
  });
});

describe('Atualizações dos Cards — listagem, filtros e histórico', () => {
  async function seedCards() {
    const tag = `Zeta${seq++}`;
    const a = nextKey('CHL');
    const b = nextKey('RISK1');
    const c = nextKey('CHL');
    await hook({ webhookEvent: 'jira:issue_updated', timestamp: 1, issue: issue(a, { summary: `Relatório de conciliação ${tag}`, status: 'PRONTO', assignee: 'João Pinto', updated: '2026-10-09T10:00:00.000+0000' }), changelog: statusHistory(8001, 'Para Deploy', 'PRONTO', user('Suporte Compartilhado', 'suporte@empresa.com'), '2026-10-09T10:00:00.000+0000') });
    await hook({ webhookEvent: 'jira:issue_updated', timestamp: 2, issue: issue(b, { summary: `Risco de integração ${tag}`, status: 'VALIDACAO PO', assignee: 'José Álvaro', updated: '2026-10-07T10:00:00.000+0000' }), changelog: statusHistory(8002, 'Em Teste Homolog', 'VALIDACAO PO', user('Carlos Lima'), '2026-10-07T10:00:00.000+0000') });
    await hook({ webhookEvent: 'comment_created', timestamp: 3, issue: issue(c, { summary: `Ajuste de tela ${tag}`, status: '00 - Backlog', assignee: null, updated: '2026-10-08T10:00:00.000+0000' }), comment: { id: '5', author: user('Pedro'), body: 'Verificar ação de conciliação', created: '2026-10-08T10:00:00.000+0000', updated: '2026-10-08T10:00:00.000+0000' } });
    return { tag, a, b, c, support: await loginAs({ roles: ['support'] }) };
  }

  it('lista independentemente do status, mais recentes primeiro, com pesquisa sem acento e filtros combináveis', async () => {
    const { tag, a, b, c, support } = await seedCards();
    const all = (await support.request('GET', `/api/cards?q=${encodeURIComponent(tag)}`)).json();
    expect(all.items.map((i: { key: string }) => i.key)).toEqual([a, c, b]); // 09/10, 08/10, 07/10
    expect(new Set(all.items.map((i: { status: string }) => i.status))).toEqual(new Set(['PRONTO', '00 - Backlog', 'VALIDACAO PO']));
    // sem acento / caixa
    expect((await support.request('GET', `/api/cards?q=${encodeURIComponent(`CONCILIACAO ${tag}`)}`)).json().total).toBe(1);
    expect((await support.request('GET', `/api/cards?q=jose%20alvaro`)).json().items.some((i: { key: string }) => i.key === b)).toBe(true);
    expect((await support.request('GET', `/api/cards?q=${a.toLowerCase()}`)).json().items[0].key).toBe(a);
    // autor das alterações (qualquer evento)
    expect((await support.request('GET', `/api/cards?q=pedro`)).json().items.some((i: { key: string }) => i.key === c)).toBe(true);
    // filtros
    const f = async (qs: string) => (await support.request('GET', `/api/cards?q=${tag}&${qs}`)).json();
    expect((await f('project=RISK1')).items.map((i: { key: string }) => i.key)).toEqual([b]);
    expect((await f(`status=${encodeURIComponent('PRONTO,00 - Backlog')}`)).total).toBe(2);
    expect((await f('assignee=Jo%C3%A3o%20Pinto')).items[0].key).toBe(a);
    expect((await f('assignee=__none__')).items.map((i: { key: string }) => i.key)).toEqual([c]);
    expect((await f('eventType=comment')).items.map((i: { key: string }) => i.key)).toEqual([c]);
    expect((await f('author=Carlos%20Lima')).items.map((i: { key: string }) => i.key)).toEqual([b]);
    expect((await f('from=2026-10-08&to=2026-10-08')).items.map((i: { key: string }) => i.key)).toEqual([c]);
    expect((await f('project=CHL&status=PRONTO&eventType=status_change')).total).toBe(1);
    const page = (await support.request('GET', `/api/cards?q=${tag}&pageSize=2&page=2`)).json();
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(1);
    // fontes dos filtros vêm do Jira (status novos aparecem sozinhos)
    expect(all.facets.statuses.map((s: { name: string }) => s.name)).toEqual(expect.arrayContaining(['PRONTO', 'VALIDACAO PO', '00 - Backlog']));
  });

  it('histórico: ordenação, filtros, pesquisa de comentário, conta compartilhada e autor desconhecido', async () => {
    const { a, c, support } = await seedCards();
    const k = nextKey();
    await hook({ webhookEvent: 'jira:issue_updated', timestamp: 10, issue: issue(k), changelog: { id: '8500', created: '2026-10-04T08:00:00.000+0000', items: [{ field: 'priority', fromString: 'Média', toString: 'Alta' }, { field: 'description', fromString: 'a', toString: 'b' }] } });
    const desc = (await support.request('GET', `/api/cards/${k}/events`)).json();
    const asc = (await support.request('GET', `/api/cards/${k}/events?order=asc`)).json();
    expect(asc.items.map((e: { id: string }) => e.id)).toEqual([...desc.items].reverse().map((e: { id: string }) => e.id));
    const pri = desc.items.find((e: { type: string }) => e.type === 'priority_change');
    expect(pri).toMatchObject({ from: 'Média', to: 'Alta', author: null });
    expect(desc.items.some((e: { type: string }) => e.type === 'description_change')).toBe(true);
    expect((await support.request('GET', `/api/cards/${k}/events?type=priority_change`)).json().total).toBe(1);
    expect((await support.request('GET', `/api/cards/${k}/events?field=description`)).json().total).toBe(1);
    expect((await support.request('GET', `/api/cards/${k}/events?from=2026-10-04&to=2026-10-04`)).json().total).toBe(2);
    const shared = (await support.request('GET', `/api/cards/${a}/events?type=status_change`)).json().items[0];
    expect(shared).toMatchObject({ author: 'Suporte Compartilhado', authorShared: true });
    const found = (await support.request('GET', `/api/cards/${c}/events?q=ACAO`)).json();
    expect(found.items.map((e: { type: string }) => e.type)).toEqual(['comment']);
    expect((await support.request('GET', `/api/cards/${c}/events?pageSize=1&page=2`)).json().items).toHaveLength(1);
    expect((await support.request('GET', `/api/cards/${nextKey()}`)).statusCode).toBe(404);
    expect((await support.request('GET', `/api/cards/inválido`)).statusCode).toBe(422);
  });
});
