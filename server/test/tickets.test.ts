import { afterAll, describe, expect, it } from 'vitest';
import { closePool, getPool, query, queryOne } from '../src/db/pool.js';
import { anonymous, createCompany, createSystem, createUser, getApp, login, loginAs, mp4Buffer, pngBuffer, type Session } from './helpers.js';

afterAll(async () => {
  await (await getApp()).close();
  await closePool();
});

async function openTicket(s: Session, overrides: Record<string, string> = {}, files?: Array<{ filename: string; content: Buffer; contentType?: string }>) {
  const systemId = overrides.systemId ?? (await createSystem());
  return s.multipart('POST', '/api/tickets', {
    fields: { title: 'Erro ao emitir nota', description: 'Ao clicar em emitir, aparece a mensagem de erro 500 e nada acontece.', systemId, ...overrides },
    files: files ?? [{ filename: 'erro.png', content: await pngBuffer(), contentType: 'image/png' }],
  });
}

describe('20.7 Abertura de tickets — validações', () => {
  it('bloqueia abertura sem usuário autenticado', async () => {
    const res = await openTicket(await anonymous());
    expect(res.statusCode).toBe(401);
  });

  it('bloqueia abertura sem sistema', async () => {
    const res = await openTicket(await loginAs({ type: 'external' }), { systemId: '' });
    expect(res.statusCode).toBe(422);
  });

  it('bloqueia abertura sem empresa', async () => {
    const internalNoCompany = await loginAs({ type: 'internal', roles: ['internal_reader'], companyId: null });
    const res = await openTicket(internalNoCompany);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.fields.companyId).toBeTruthy();
    // Usuário interno pode informar a empresa atendida.
    const ok = await openTicket(internalNoCompany, { companyId: await createCompany() });
    expect(ok.statusCode).toBe(201);
  });

  it('bloqueia abertura sem descrição', async () => {
    const res = await openTicket(await loginAs({ type: 'external' }), { description: '' });
    expect(res.statusCode).toBe(422);
  });

  it('bloqueia abertura sem pelo menos uma imagem ou vídeo', async () => {
    const res = await openTicket(await loginAs({ type: 'external' }), {}, []);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/imagem ou vídeo/);
  });

  it('rejeita anexos inválidos (PDF/texto ou arquivo com extensão falsa)', async () => {
    const s = await loginAs({ type: 'external' });
    const fake = await openTicket(s, {}, [{ filename: 'print.png', content: Buffer.from('não é uma imagem'), contentType: 'image/png' }]);
    expect(fake.statusCode).toBe(415);
    const mixed = await openTicket(s, {}, [
      { filename: 'ok.png', content: await pngBuffer(), contentType: 'image/png' },
      { filename: 'doc.txt', content: Buffer.from('texto'), contentType: 'text/plain' },
    ]);
    expect(mixed.statusCode).toBe(415);
    // Nada foi gravado.
    expect(await queryOne(`SELECT 1 FROM tickets WHERE requester_id = $1`, [s.userId])).toBeNull();
  });

  it('gera protocolo, preenche usuário e empresa automaticamente e aceita vídeo', async () => {
    const companyId = await createCompany();
    const user = await createUser({ type: 'external', companyId });
    const s = await login(user);
    const res = await openTicket(s, { companyId: await createCompany() }, [{ filename: 'gravacao.mp4', content: mp4Buffer(), contentType: 'video/mp4' }]);
    expect(res.statusCode).toBe(201);
    const t = res.json().ticket;
    expect(t.protocol).toMatch(/^\d{10}$/);
    const row = await queryOne<{ requester_id: string; company_id: string; status: string }>(`SELECT * FROM tickets WHERE id = $1`, [t.id]);
    expect(row!.requester_id).toBe(user.id);
    // Usuário externo não escolhe empresa arbitrária: usa a própria.
    expect(row!.company_id).toBe(companyId);
    expect(row!.status).toBe('open');
  });
});

describe('20.7/13 Meus tickets e atendimento', () => {
  async function scenario() {
    const companyId = await createCompany();
    const customer = await login(await createUser({ type: 'external', companyId, name: 'Cliente Ana' }));
    const colleague = await login(await createUser({ type: 'external', companyId }));
    const stranger = await loginAs({ type: 'external' });
    const support = await loginAs({ roles: ['support'], name: 'Atendente Beto' });
    const t = (await openTicket(customer)).json().ticket;
    return { companyId, customer, colleague, stranger, support, t };
  }

  it('cliente consulta todos os seus tickets, inclusive fechados, com filtros e ordenação', async () => {
    const { customer, support, t } = await scenario();
    const t2 = (await openTicket(customer, { title: 'Segundo chamado' })).json().ticket;
    await support.request('PUT', `/api/support/tickets/${t.id}/resolution`, { solution: 'Atualizado o certificado.', resolve: true });
    await customer.request('POST', `/api/tickets/${t.id}/confirm-resolution`);
    const list = (await customer.request('GET', '/api/tickets/mine')).json();
    expect(list.items.map((i: { id: string }) => i.id)).toEqual(expect.arrayContaining([t.id, t2.id]));
    expect(list.items.find((i: { id: string }) => i.id === t.id).status).toBe('closed');
    const closed = (await customer.request('GET', '/api/tickets/mine?status=closed')).json();
    expect(closed.items.map((i: { id: string }) => i.id)).toEqual([t.id]);
    const byProtocol = (await customer.request('GET', `/api/tickets/mine?q=${t2.protocol}`)).json();
    expect(byProtocol.items.map((i: { id: string }) => i.id)).toEqual([t2.id]);
    const asc = (await customer.request('GET', '/api/tickets/mine?sort=created_asc')).json();
    expect(asc.items[0].id).toBe(t.id);
  });

  it('cliente não acessa tickets de terceiros alterando o ID (nem anexos)', async () => {
    const { t, stranger, colleague } = await scenario();
    for (const s of [stranger, colleague]) {
      expect((await s.request('GET', `/api/tickets/${t.id}`)).statusCode).toBe(404);
      expect((await s.multipart('POST', `/api/tickets/${t.id}/messages`, { fields: { body: 'oi' } })).statusCode).toBe(404);
      expect((await s.request('POST', `/api/tickets/${t.id}/reopen`, { reason: 'Quero reabrir o ticket alheio' })).statusCode).toBe(404);
    }
    const file = await queryOne<{ file_id: string }>(`SELECT file_id FROM ticket_attachments WHERE ticket_id = $1`, [t.id]);
    expect((await stranger.request('GET', `/api/files/${file!.file_id}`)).statusCode).toBe(404);
    const denied = await queryOne(`SELECT 1 FROM audit_logs WHERE action = 'ticket.access_denied' AND entity_id = $1`, [t.id]);
    expect(denied).toBeTruthy();
  });

  it('compartilhamento entre usuários da mesma empresa depende de permissão específica', async () => {
    const { t, colleague, companyId } = await scenario();
    expect((await colleague.request('GET', `/api/tickets/${t.id}`)).statusCode).toBe(404);
    const manager = await login(await createUser({ type: 'external', companyId, grant: ['tickets.view_company'] }));
    expect((await manager.request('GET', `/api/tickets/${t.id}`)).statusCode).toBe(200);
    const list = (await manager.request('GET', '/api/tickets/mine?scope=company')).json();
    expect(list.items.map((i: { id: string }) => i.id)).toContain(t.id);
  });

  it('cliente visualiza respostas, solicitações de informação, solução e histórico de status', async () => {
    const { customer, support, t } = await scenario();
    await support.multipart('POST', `/api/support/tickets/${t.id}/reply`, { fields: { body: 'Estamos analisando.', kind: 'support_reply' } });
    await support.multipart('POST', `/api/support/tickets/${t.id}/reply`, { fields: { body: 'Envie o print da tela de configuração.', kind: 'info_request' } });
    let detail = (await customer.request('GET', `/api/tickets/${t.id}`)).json().ticket;
    expect(detail.status).toBe('waiting_user');
    // Resposta do cliente com anexo retorna o ticket para atendimento.
    const reply = await customer.multipart('POST', `/api/tickets/${t.id}/messages`, {
      fields: { body: 'Segue o print.' },
      files: [{ filename: 'config.png', content: await pngBuffer(), contentType: 'image/png' }],
    });
    expect(reply.statusCode).toBe(200);
    await support.request('PUT', `/api/support/tickets/${t.id}/resolution`, {
      analysisResult: 'Certificado expirado.',
      procedures: 'Renovado o certificado A1.',
      solution: 'Certificado atualizado; emissão normalizada.',
      guidance: 'Acompanhe a validade do certificado.',
      resolve: true,
    });
    detail = (await customer.request('GET', `/api/tickets/${t.id}`)).json().ticket;
    expect(detail.status).toBe('resolved');
    expect(detail.solution).toContain('Certificado atualizado');
    expect(detail.procedures).toContain('Renovado');
    const kinds = detail.timeline.filter((e: { type: string }) => e.type === 'message').map((e: { kind: string }) => e.kind);
    expect(kinds).toEqual(['support_reply', 'info_request', 'customer_message', 'solution']);
    const statusEvents = detail.timeline.filter((e: { eventType?: string }) => e.eventType === 'status_change');
    expect(statusEvents.map((e: { to: string }) => e.to)).toEqual(['in_progress', 'waiting_user', 'in_progress', 'resolved']);
    expect(statusEvents.every((e: { createdAt: string; author: { name: string } }) => e.createdAt && e.author.name)).toBe(true);
    // Ordem cronológica e autor identificado
    const times = detail.timeline.map((e: { createdAt: string }) => new Date(e.createdAt).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(detail.timeline.find((e: { kind?: string }) => e.kind === 'support_reply').author.name).toBe('Atendente Beto');
    // Anexo da mensagem do cliente aparece no histórico
    expect(detail.timeline.find((e: { kind?: string }) => e.kind === 'customer_message').files).toHaveLength(1);
  });

  it('observações internas nunca aparecem para o cliente (nem seus anexos)', async () => {
    const { customer, support, t } = await scenario();
    await support.multipart('POST', `/api/support/tickets/${t.id}/notes`, {
      fields: { body: 'NOTA INTERNA: cliente com contrato vencido' },
      files: [{ filename: 'interno.png', content: await pngBuffer(), contentType: 'image/png' }],
    });
    const customerView = await customer.request('GET', `/api/tickets/${t.id}`);
    expect(customerView.body).not.toContain('NOTA INTERNA');
    expect(customerView.json().ticket.timeline.some((e: { type: string }) => e.type === 'internal_note')).toBe(false);
    const supportView = (await support.request('GET', `/api/tickets/${t.id}`)).json().ticket;
    const note = supportView.timeline.find((e: { type: string }) => e.type === 'internal_note');
    expect(note.body).toContain('NOTA INTERNA');
    // O arquivo da observação interna não é acessível pelo cliente.
    expect((await customer.request('GET', note.files[0].url)).statusCode).toBe(404);
    expect((await support.request('GET', note.files[0].url)).statusCode).toBe(200);
  });

  it('cliente não altera estados administrativos; transições inválidas são rejeitadas', async () => {
    const { customer, support, t } = await scenario();
    expect((await customer.request('POST', `/api/support/tickets/${t.id}/status`, { status: 'closed' })).statusCode).toBe(403);
    expect((await customer.request('POST', `/api/tickets/${t.id}/confirm-resolution`)).statusCode).toBe(409);
    expect((await support.request('POST', `/api/support/tickets/${t.id}/status`, { status: 'resolved' })).statusCode).toBe(422);
    expect((await support.request('POST', `/api/support/tickets/${t.id}/status`, { status: 'triage' })).statusCode).toBe(200);
  });

  it('reabertura preserva o histórico e respeita o prazo configurado', async () => {
    const { customer, support, t } = await scenario();
    await support.request('PUT', `/api/support/tickets/${t.id}/resolution`, { solution: 'Resolvido.', resolve: true });
    await customer.request('POST', `/api/tickets/${t.id}/confirm-resolution`);
    const reopen = await customer.request('POST', `/api/tickets/${t.id}/reopen`, { reason: 'O erro voltou a acontecer hoje.' });
    expect(reopen.statusCode).toBe(200);
    const detail = (await customer.request('GET', `/api/tickets/${t.id}`)).json().ticket;
    expect(detail.status).toBe('triage');
    expect(detail.timeline.some((e: { kind?: string }) => e.kind === 'solution')).toBe(true);

    await support.request('PUT', `/api/support/tickets/${t.id}/resolution`, { solution: 'Resolvido de novo.', resolve: true });
    await getPool().query(`UPDATE tickets SET resolved_at = now() - interval '30 days', updated_at = now() - interval '30 days' WHERE id = $1`, [t.id]);
    const late = await customer.request('POST', `/api/tickets/${t.id}/reopen`, { reason: 'Tentando reabrir após o prazo.' });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('REOPEN_WINDOW_EXPIRED');
  });

  it('histórico permanece após o fechamento e não pode ser alterado', async () => {
    const { customer, support, t } = await scenario();
    await support.request('PUT', `/api/support/tickets/${t.id}/resolution`, { solution: 'Ok.', resolve: true });
    await customer.request('POST', `/api/tickets/${t.id}/confirm-resolution`);
    const detail = (await customer.request('GET', `/api/tickets/${t.id}`)).json().ticket;
    expect(detail.status).toBe('closed');
    expect(detail.closedAt).toBeTruthy();
    expect(detail.timeline.length).toBeGreaterThan(2);
    await expect(getPool().query(`DELETE FROM ticket_messages WHERE ticket_id = $1`, [t.id])).rejects.toThrow(/imutáveis/);
    await expect(getPool().query(`UPDATE ticket_events SET to_status = 'open' WHERE ticket_id = $1`, [t.id])).rejects.toThrow(/imutáveis/);
    // Ticket fechado não aceita novas mensagens (somente reabertura).
    expect((await customer.multipart('POST', `/api/tickets/${t.id}/messages`, { fields: { body: 'oi' } })).statusCode).toBe(409);
  });

  it('suporte vê apenas tickets sem responsável ou atribuídos a si; administração vê todos e atribui', async () => {
    const { t } = await scenario();
    const s1 = await loginAs({ roles: ['support'] });
    const s2 = await loginAs({ roles: ['support'] });
    const manager = await loginAs({ roles: ['support'], grant: ['tickets.manage'] });
    expect((await s1.request('POST', `/api/support/tickets/${t.id}/assign`, { assigneeId: s1.userId })).statusCode).toBe(200);
    expect((await s2.request('GET', `/api/tickets/${t.id}`)).statusCode).toBe(404);
    const list = (await s2.request('GET', '/api/support/tickets?pageSize=100')).json();
    expect(list.items.map((i: { id: string }) => i.id)).not.toContain(t.id);
    expect((await s2.request('POST', `/api/support/tickets/${t.id}/assign`, { assigneeId: s2.userId })).statusCode).toBe(404);
    expect((await manager.request('POST', `/api/support/tickets/${t.id}/assign`, { assigneeId: s2.userId })).statusCode).toBe(200);
    expect((await s2.request('GET', `/api/tickets/${t.id}`)).statusCode).toBe(200);
    // A administração lista todos os tickets, com e sem filtros.
    const all = await manager.request('GET', '/api/support/tickets?pageSize=100&status=');
    expect(all.statusCode).toBe(200);
    expect(all.json().items.map((i: { id: string }) => i.id)).toContain(t.id);
    expect((await manager.request('GET', `/api/support/tickets?q=${t.protocol}&assignee=none`)).statusCode).toBe(200);
    const events = await query(`SELECT * FROM ticket_events WHERE ticket_id = $1 AND type = 'assignment'`, [t.id]);
    expect(events).toHaveLength(2);
  });

  it('relaciona artigos e sugere criação de artigo a partir da solução', async () => {
    const { customer, t } = await scenario();
    const support = await loginAs({ roles: ['support'], grant: ['articles.create'] });
    await support.request('PUT', `/api/support/tickets/${t.id}/resolution`, { solution: 'Limpar o cache do navegador.', procedures: 'Ctrl+Shift+Del', resolve: false });
    const sug = await support.request('POST', `/api/support/tickets/${t.id}/suggest-article`);
    expect(sug.statusCode).toBe(201);
    const article = await queryOne<{ status: string; visibility: string; content_text: string }>(`SELECT * FROM articles WHERE id = $1`, [sug.json().article.id]);
    expect(article!.status).toBe('draft');
    expect(article!.visibility).toBe('internal');
    expect(article!.content_text).toContain('Limpar o cache');
    // O vínculo com o artigo interno em rascunho não aparece para o cliente.
    const detail = (await customer.request('GET', `/api/tickets/${t.id}`)).json().ticket;
    expect(detail.relatedArticles).toHaveLength(0);
  });
});
