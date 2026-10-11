import { afterAll, describe, expect, it } from 'vitest';
import { closePool, queryOne } from '../src/db/pool.js';
import { adfToText, fieldValues, parseAudience, parseIssue, releaseJql, setJiraFetch } from '../src/modules/updates/jira.js';
import { anonymous, createSystem, getApp, loginAs, uid, type Session } from './helpers.js';

afterAll(async () => {
  setJiraFetch(null);
  await (await getApp()).close();
  await closePool();
});

const SECRET = 'segredo-de-teste-do-jira';
const NAMES = { customfield_10050: 'Release', customfield_10060: 'Público alvo' };

function issue(key: string, over: { status?: string; category?: string; release?: unknown; audience?: unknown; summary?: string; description?: unknown; component?: string } = {}) {
  return {
    webhookEvent: 'jira:issue_updated',
    issue: {
      key,
      names: NAMES,
      fields: {
        summary: over.summary ?? `Entrega ${key}`,
        description: over.description ?? 'Melhoria entregue.',
        status: { name: over.status ?? 'Concluído', statusCategory: { key: over.category ?? 'done' } },
        customfield_10050: over.release === undefined ? 'v2026.11.0' : over.release,
        customfield_10060: over.audience === undefined ? { value: 'Externo' } : over.audience,
        components: over.component ? [{ name: over.component }] : [],
        resolutiondate: '2026-10-10T12:00:00.000-0300',
      },
    },
  };
}
const key = () => `LOGAE-${Math.floor(Math.random() * 1e8)}`;

async function hook(body: unknown, secret: string | null = SECRET, how: 'header' | 'query' = 'header') {
  const app = await getApp();
  return app.inject({
    method: 'POST',
    url: `/api/integrations/jira/webhook${secret && how === 'query' ? `?secret=${secret}` : ''}`,
    headers: secret && how === 'header' ? { 'x-jira-secret': secret } : {},
    payload: body as object,
  });
}

describe('Atualizações — integração com o Jira', () => {
  it('rejeita webhook sem segredo ou com segredo errado', async () => {
    expect((await hook(issue(key()), null)).statusCode).toBe(401);
    expect((await hook(issue(key()), 'errado')).statusCode).toBe(401);
    expect((await hook({})).statusCode).toBe(400);
  });

  it('tarefa concluída com release preenchido vai direto para as atualizações', async () => {
    const k = key();
    const sysName = uid('Plataforma ');
    const sysId = await createSystem(sysName);
    const res = await hook(issue(k, { release: 'v2026.11.0', summary: 'Novo filtro de período', component: sysName }));
    expect(res.statusCode).toBe(200);
    expect(res.json().results[k]).toBe('published');
    const row = await queryOne<{ status: string; release: string; visibility: string; system_id: string; jira_url: string; completed_at: Date }>(`SELECT * FROM updates WHERE jira_key = $1`, [k]);
    expect(row).toMatchObject({ status: 'published', release: 'v2026.11.0', visibility: 'external', system_id: sysId, jira_url: `https://exemplo.atlassian.net/browse/${k}` });
    expect(row!.completed_at.toISOString()).toBe('2026-10-10T15:00:00.000Z');
    // Autenticação por query string também é aceita (webhooks clássicos do Jira)
    const k2 = key();
    expect((await hook(issue(k2), SECRET, 'query')).json().results[k2]).toBe('published');
  });

  it('não publica quando a tarefa não está concluída ou o release está vazio', async () => {
    const a = key();
    const b = key();
    const c = key();
    expect((await hook(issue(a, { status: 'Em andamento', category: 'indeterminate' }))).json().results[a]).toBe('ignored');
    expect((await hook(issue(b, { release: null }))).json().results[b]).toBe('ignored');
    expect((await hook(issue(c, { release: [] }))).json().results[c]).toBe('ignored');
    expect(await queryOne(`SELECT 1 FROM updates WHERE jira_key = ANY($1::text[])`, [[a, b, c]])).toBeNull();
  });

  it('reconhece a conclusão pelo nome do status quando a categoria não vem no payload', async () => {
    const k = key();
    const body = issue(k);
    (body.issue.fields.status as { statusCategory?: unknown }).statusCategory = undefined;
    expect((await hook(body)).json().results[k]).toBe('published');
  });

  it('o campo "Público alvo" define quem visualiza (externo, ambos e interno; ausente = interno)', async () => {
    const ext = key();
    const both = key();
    const int = key();
    const none = key();
    await hook(issue(ext, { audience: { value: 'Externo' } }));
    await hook(issue(both, { audience: [{ value: 'Interno' }, { value: 'Externo' }] }));
    await hook(issue(int, { audience: { value: 'Interno' } }));
    await hook(issue(none, { audience: null }));
    const vis = async (k: string) => (await queryOne<{ visibility: string }>(`SELECT visibility FROM updates WHERE jira_key = $1`, [k]))!.visibility;
    expect(await vis(ext)).toBe('external');
    expect(await vis(both)).toBe('external');
    expect(await vis(int)).toBe('internal');
    expect(await vis(none)).toBe('internal');

    const anon = await anonymous();
    const external = await loginAs({ type: 'external' });
    const internal = await loginAs({ roles: ['internal_reader'] });
    const ids = async (s: Session) => (await s.request('GET', '/api/updates?pageSize=100')).json().items.map((i: { jiraKey: string }) => i.jiraKey);
    for (const s of [anon, external]) {
      const list = await ids(s);
      expect(list).toEqual(expect.arrayContaining([ext, both]));
      expect(list).not.toContain(int);
      expect(list).not.toContain(none);
    }
    expect(await ids(internal)).toEqual(expect.arrayContaining([ext, both, int, none]));
  });

  it('usuários externos apenas visualizam: não alteram nem sincronizam; acesso direto ao interno é negado', async () => {
    const k = key();
    await hook(issue(k, { audience: { value: 'Interno' } }));
    const row = (await queryOne<{ id: string }>(`SELECT id FROM updates WHERE jira_key = $1`, [k]))!;
    const external = await loginAs({ type: 'external' });
    expect((await external.request('GET', `/api/updates/${row.id}`)).statusCode).toBe(404);
    expect((await (await anonymous()).request('GET', `/api/updates/${row.id}`)).statusCode).toBe(404);
    expect((await external.request('PUT', `/api/updates/${row.id}`, { status: 'hidden' })).statusCode).toBe(403);
    expect((await external.request('POST', '/api/updates/sync')).statusCode).toBe(403);
    expect((await external.request('GET', '/api/updates?manage=1')).json().items.map((i: { jiraKey: string }) => i.jiraKey)).not.toContain(k);
    const reader = await loginAs({ roles: ['internal_reader'] });
    expect((await reader.request('PUT', `/api/updates/${row.id}`, { status: 'hidden' })).statusCode).toBe(403);
    expect((await reader.request('GET', `/api/updates/${row.id}`)).statusCode).toBe(200);
  });

  it('reabrir a tarefa ou limpar o release oculta a atualização; concluir novamente republica', async () => {
    const k = key();
    await hook(issue(k));
    expect((await hook(issue(k, { status: 'Em andamento', category: 'indeterminate' }))).json().results[k]).toBe('hidden');
    const status = async () => (await queryOne<{ status: string }>(`SELECT status FROM updates WHERE jira_key = $1`, [k]))!.status;
    expect(await status()).toBe('hidden');
    expect((await (await anonymous()).request('GET', '/api/updates?pageSize=100')).json().items.map((i: { jiraKey: string }) => i.jiraKey)).not.toContain(k);
    expect((await hook(issue(k, { summary: 'Título revisado' }))).json().results[k]).toBe('updated');
    expect(await status()).toBe('published');
    expect((await queryOne<{ title: string }>(`SELECT title FROM updates WHERE jira_key = $1`, [k]))!.title).toBe('Título revisado');
  });

  it('ajuste manual (público/situação) é preservado em novas notificações do Jira', async () => {
    const admin = await loginAs({ roles: ['admin'] });
    const k = key();
    await hook(issue(k, { audience: { value: 'Externo' } }));
    const id = (await queryOne<{ id: string }>(`SELECT id FROM updates WHERE jira_key = $1`, [k]))!.id;
    expect((await admin.request('PUT', `/api/updates/${id}`, { visibility: 'internal', status: 'hidden' })).statusCode).toBe(200);
    await hook(issue(k, { audience: { value: 'Externo' }, summary: 'Mudou no Jira' }));
    const row = await queryOne<{ visibility: string; status: string; title: string; manual_override: boolean }>(`SELECT * FROM updates WHERE id = $1`, [id]);
    expect(row).toMatchObject({ visibility: 'internal', status: 'hidden', title: 'Mudou no Jira', manual_override: true });
    expect((await admin.request('POST', `/api/updates/${id}/release-control`)).statusCode).toBe(200);
    await hook(issue(k, { audience: { value: 'Externo' } }));
    expect(await queryOne(`SELECT 1 FROM updates WHERE id = $1 AND visibility = 'external' AND status = 'published'`, [id])).toBeTruthy();
    expect(await queryOne(`SELECT 1 FROM audit_logs WHERE action = 'update.manual_change' AND entity_id = $1`, [id])).toBeTruthy();
  });

  it('busca o mapa de nomes na API do Jira quando o webhook não o envia', async () => {
    let called = '';
    setJiraFetch(async (url, init) => {
      called = url;
      expect(init.headers.Authorization).toMatch(/^Basic /);
      return { ok: true, status: 200, json: async () => ({ key: 'X', fields: {}, names: NAMES }) };
    });
    const k = key();
    const body = issue(k);
    delete (body.issue as { names?: unknown }).names;
    setJiraFetch(async (url) => {
      called = url;
      return { ok: true, status: 200, json: async () => ({ ...body.issue, names: NAMES }) };
    });
    expect((await hook(body)).json().results[k]).toBe('published');
    expect(called).toContain(`/rest/api/3/issue/${k}?expand=names`);
    setJiraFetch(null);
  });

  it('sincronização manual consulta o Jira (JQL de concluídas com release) e publica', async () => {
    const admin = await loginAs({ roles: ['admin'] });
    const k = key();
    let url = '';
    setJiraFetch(async (u) => {
      url = u;
      return { ok: true, status: 200, json: async () => ({ names: NAMES, isLast: true, issues: [issue(k).issue, issue(key(), { release: null }).issue] }) };
    });
    const res = await admin.request('POST', '/api/updates/sync');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ found: 2, published: 1, ignored: 1 });
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain('statusCategory = Done AND cf[10050] is not EMPTY');
    const support = await loginAs({ roles: ['support'] });
    expect((await support.request('POST', '/api/updates/sync')).statusCode).toBe(403);
    setJiraFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    expect((await admin.request('POST', '/api/updates/sync')).statusCode).toBe(503);
    setJiraFetch(null);
  });
});

describe('Jira — interpretação dos campos', () => {
  it('extrai valores de campos simples, de seleção, múltiplos e de versões', () => {
    expect(fieldValues('v1')).toEqual(['v1']);
    expect(fieldValues({ value: 'Externo' })).toEqual(['Externo']);
    expect(fieldValues([{ name: 'v1.0' }, { name: 'v1.1' }])).toEqual(['v1.0', 'v1.1']);
    expect(fieldValues({ value: 'Cliente', child: { value: 'Premium' } })).toEqual(['Cliente', 'Premium']);
    expect(fieldValues(null)).toEqual([]);
  });
  it('classifica o público alvo com padrão seguro (interno)', () => {
    expect(parseAudience(['Externo'])).toBe('external');
    expect(parseAudience(['Clientes'])).toBe('external');
    expect(parseAudience(['Ambos'])).toBe('external');
    expect(parseAudience(['Todos'])).toBe('external');
    expect(parseAudience(['Interno'])).toBe('internal');
    expect(parseAudience(['Equipe de QA'])).toBe('internal');
    expect(parseAudience([])).toBe('internal');
  });
  it('converte descrição em ADF para texto e monta a JQL do release', () => {
    const adf = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Linha 1' }] }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item' }] }] }] }] };
    expect(adfToText(adf).trim()).toBe('Linha 1\n\n• Item');
    expect(releaseJql('fixVersions')).toBe('fixVersion is not EMPTY');
    expect(releaseJql('customfield_10050')).toBe('cf[10050] is not EMPTY');
    expect(releaseJql('Release')).toBe('"Release" is not EMPTY');
  });
  it('resolve campos por id ou por nome', () => {
    const p = parseIssue({ key: 'A-1', names: NAMES, fields: { summary: 's', status: { name: 'Done', statusCategory: { key: 'done' } }, customfield_10050: 'v9', customfield_10060: 'Interno' } });
    expect(p).toMatchObject({ release: 'v9', visibility: 'internal', done: true });
  });
});
