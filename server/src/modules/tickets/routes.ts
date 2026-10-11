import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  TICKET_PRIORITIES,
  TICKET_REQUEST_TYPES,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  type TicketStatus,
} from '@shared/domain.js';
import { config } from '../../config.js';
import { getPool, query, queryOne, withTransaction } from '../../db/pool.js';
import { allowedVisibilities, requireAnyPermission, requireAuth, requirePermission } from '../../auth/context.js';
import { canSupportTicket, canViewArticle, canViewTicketAsCustomer } from '../../auth/policies.js';
import { audit } from '../../lib/audit.js';
import { conflict, forbidden, notFound, validationError } from '../../lib/errors.js';
import { readMultipart } from '../../lib/multipart.js';
import { sanitizePlainText } from '../../lib/sanitize.js';
import { escapeHtml, slugify, truncate } from '../../lib/text.js';
import { dateRange, pageQuery, parse, uuid } from '../../lib/validate.js';
import { createArticle } from '../articles/service.js';
import {
  addEvent,
  assertSupport,
  attachFiles,
  canSupportTransition,
  loadTicket,
  loadTicketForViewer,
  MEDIA_TYPES,
  nextProtocol,
  prevalidateFiles,
  serializeTicketDetail,
  serializeTicketSummary,
  setStatus,
  type TicketRow,
} from './service.js';
import { ATTACHMENT_MIME_TYPES } from '@shared/uploads.js';

const SUMMARY_SELECT = `
  SELECT t.id, t.protocol, t.title, t.status, t.priority, t.request_type, t.created_at, t.updated_at,
         s.name AS system_name, c.name AS company_name, r.name AS requester_name, a.name AS assignee_name,
         count(*) OVER () AS total
    FROM tickets t
    JOIN systems s ON s.id = t.system_id
    JOIN companies c ON c.id = t.company_id
    JOIN users r ON r.id = t.requester_id
    LEFT JOIN users a ON a.id = t.assignee_id`;

const SORTS: Record<string, string> = {
  updated_desc: 't.updated_at DESC',
  updated_asc: 't.updated_at ASC',
  created_desc: 't.created_at DESC',
  created_asc: 't.created_at ASC',
  status: 't.status ASC, t.updated_at DESC',
  priority: `array_position(ARRAY['critical','high','medium','low'], t.priority), t.updated_at DESC`,
};

const createSchema = z.object({
  title: z.string().trim().max(150, 'O título deve ter no máximo 150 caracteres.').optional().default(''),
  systemId: z.string({ required_error: 'Selecione o sistema.' }).uuid('Selecione o sistema.'),
  companyId: z.string().uuid().optional(),
  description: z
    .string({ required_error: 'Descreva o problema, dúvida ou solicitação.' })
    .trim()
    .min(10, 'Descreva o problema com pelo menos 10 caracteres.')
    .max(20_000),
  requestType: z.enum(TICKET_REQUEST_TYPES).default('incident'),
  categoryId: z.string().uuid().optional().or(z.literal('').transform(() => undefined)),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
});

export default async function ticketRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Dados do formulário de abertura (usuário, empresa e sistemas)
  // -------------------------------------------------------------------------
  app.get('/api/tickets/form-options', async (req) => {
    const user = requireAuth(req);
    const systems = await query(`SELECT id, name FROM systems WHERE active ORDER BY name`);
    const categories = await query(`SELECT id, name FROM categories ORDER BY sort_order, name`);
    // Usuários internos sem empresa vinculada podem selecionar a empresa atendida.
    const companies =
      user.userType === 'internal' && !user.companyId ? await query(`SELECT id, name FROM companies WHERE active ORDER BY name`) : [];
    return {
      user: { id: user.id, name: user.name, email: user.email },
      company: user.companyId ? { id: user.companyId, name: user.companyName } : null,
      companies,
      systems,
      categories,
      limits: { maxImageMb: config().MAX_IMAGE_MB, maxVideoMb: config().MAX_VIDEO_MB, maxFiles: 10 },
    };
  });

  // -------------------------------------------------------------------------
  // Abertura de ticket (multipart: campos + pelo menos uma imagem ou vídeo)
  // -------------------------------------------------------------------------
  app.post(
    '/api/tickets',
    { config: { rateLimit: { max: config().RATE_LIMIT_TICKETS_PER_HOUR, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const user = requireAuth(req); // sem usuário autenticado não há abertura
      const form = await readMultipart(req, { maxFiles: 10 });
      try {
        const body = parse(createSchema, form.fields);

        let companyId = user.companyId;
        if (!companyId) {
          if (user.userType === 'internal' && body.companyId) {
            const c = await queryOne(`SELECT 1 FROM companies WHERE id = $1 AND active`, [body.companyId]);
            if (c) companyId = body.companyId;
          }
        }
        if (!companyId) throw validationError('Informe a empresa vinculada ao atendimento.', { fields: { companyId: 'Empresa obrigatória.' } });

        const system = await queryOne(`SELECT 1 FROM systems WHERE id = $1 AND active`, [body.systemId]);
        if (!system) throw validationError('Selecione um sistema válido.', { fields: { systemId: 'Sistema inválido.' } });
        if (body.categoryId && !(await queryOne(`SELECT 1 FROM categories WHERE id = $1`, [body.categoryId]))) {
          throw validationError('Categoria inválida.', { fields: { categoryId: 'Categoria inválida.' } });
        }
        if (!form.files.length) {
          throw validationError('Anexe pelo menos uma imagem ou vídeo para abrir o ticket.', { fields: { files: 'Anexo de imagem ou vídeo obrigatório.' } });
        }
        // Todos os anexos da abertura devem ser imagens ou vídeos válidos (assinatura real do arquivo).
        await prevalidateFiles(form.files, MEDIA_TYPES);

        const description = sanitizePlainText(body.description);
        const title = sanitizePlainText(body.title || truncate(description.replace(/\s+/g, ' '), 80), 150);

        const ticket = await withTransaction(async (client) => {
          const protocol = await nextProtocol(client);
          const t = (await queryOne<TicketRow>(
            `INSERT INTO tickets (protocol, title, description, request_type, category_id, priority, system_id, company_id, requester_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [protocol, title, description, body.requestType, body.categoryId ?? null, body.priority, body.systemId, companyId, user.id],
            client,
          ))!;
          await attachFiles(client, t.id, form.files, user.id, { mediaOnly: true });
          await addEvent(client, t.id, user.id, 'created', { to: 'open', data: { protocol } });
          return t;
        });
        await audit({ actorId: user.id, action: 'ticket.create', entityType: 'ticket', entityId: ticket.id, data: { protocol: ticket.protocol }, ip: req.ip });
        reply.code(201);
        return { ticket: { id: ticket.id, protocol: ticket.protocol, status: ticket.status, createdAt: ticket.created_at } };
      } finally {
        await form.cleanup();
      }
    },
  );

  // -------------------------------------------------------------------------
  // Meus tickets (todos, inclusive resolvidos e fechados)
  // -------------------------------------------------------------------------
  app.get('/api/tickets/mine', async (req) => {
    const user = requireAuth(req);
    const q = parse(
      z.object({
        q: z.string().max(150).optional(),
        status: z.enum(TICKET_STATUSES).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        sort: z.enum(Object.keys(SORTS) as [string, ...string[]]).default('updated_desc'),
        scope: z.enum(['mine', 'company']).default('mine'),
      }).merge(pageQuery),
      req.query,
    );
    const range = dateRange(q.from, q.to);
    const companyScope = q.scope === 'company' && user.permissions.has('tickets.view_company') && !!user.companyId;
    const rows = await query(
      `${SUMMARY_SELECT}
        WHERE ${companyScope ? 't.company_id = $1' : 't.requester_id = $1'}
          AND ($2::text IS NULL OR t.protocol ILIKE '%' || $2 || '%' OR immutable_unaccent(lower(t.title)) LIKE '%' || immutable_unaccent(lower($2)) || '%')
          AND ($3::text IS NULL OR t.status = $3)
          AND ($4::timestamptz IS NULL OR t.created_at >= $4)
          AND ($5::timestamptz IS NULL OR t.created_at <= $5)
        ORDER BY ${SORTS[q.sort]}
        LIMIT $6 OFFSET $7`,
      [companyScope ? user.companyId : user.id, q.q?.trim() || null, q.status ?? null, range.from, range.to, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return {
      total: rows.length ? Number(rows[0]!.total) : 0,
      canViewCompany: user.permissions.has('tickets.view_company') && !!user.companyId,
      items: await serializeTicketSummary(rows),
    };
  });

  app.get('/api/tickets/:id', async (req) => {
    const user = requireAuth(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { as } = parse(z.object({ as: z.enum(['customer', 'support']).optional() }), req.query);
    const t = await loadTicketForViewer(user, id, req.ip);
    let mode: 'customer' | 'support' = canViewTicketAsCustomer(user, t) ? 'customer' : 'support';
    if (as === 'support' && canSupportTicket(user, t)) mode = 'support';
    if (as === 'customer' && !canViewTicketAsCustomer(user, t)) throw forbidden();
    return { ticket: await serializeTicketDetail(user, t, mode) };
  });

  // Mensagem do cliente (respostas e informações adicionais, com anexos opcionais).
  app.post('/api/tickets/:id/messages', async (req) => {
    const user = requireAuth(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const form = await readMultipart(req, { maxFiles: 10 });
    try {
      const { body } = parse(z.object({ body: z.string().trim().min(1, 'Escreva a mensagem.').max(20_000) }), form.fields);
      const t0 = await loadTicketForViewer(user, id, req.ip);
      if (!canViewTicketAsCustomer(user, t0)) throw forbidden('Use a área de atendimento para responder como suporte.');
      if (t0.status === 'closed') {
        throw conflict('TICKET_CLOSED', 'Este ticket está fechado. Solicite a reabertura informando o motivo ou abra um novo ticket.');
      }
      await prevalidateFiles(form.files, MEDIA_TYPES);
      const message = await withTransaction(async (client) => {
        const t = (await loadTicket(id, client, true))!;
        const m = await queryOne<{ id: string }>(
          `INSERT INTO ticket_messages (ticket_id, author_id, kind, body) VALUES ($1, $2, 'customer_message', $3) RETURNING id`,
          [id, user.id, sanitizePlainText(body)],
          client,
        );
        await attachFiles(client, id, form.files, user.id, { messageId: m!.id, mediaOnly: true });
        // Resposta a uma solicitação de informações: retorna automaticamente para atendimento.
        if (t.status === 'waiting_user') await setStatus(client, t, 'in_progress', null, { reason: 'Usuário respondeu à solicitação de informações' });
        await client.query(`UPDATE tickets SET updated_at = now() WHERE id = $1`, [id]);
        return m!;
      });
      await audit({ actorId: user.id, action: 'ticket.customer_message', entityType: 'ticket', entityId: id, data: { files: form.files.length }, ip: req.ip });
      return { ok: true, messageId: message.id };
    } finally {
      await form.cleanup();
    }
  });

  // Confirmação de resolução pelo cliente: Resolvido → Fechado.
  app.post('/api/tickets/:id/confirm-resolution', async (req) => {
    const user = requireAuth(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const t0 = await loadTicketForViewer(user, id, req.ip);
    if (!canViewTicketAsCustomer(user, t0)) throw forbidden();
    await withTransaction(async (client) => {
      const t = (await loadTicket(id, client, true))!;
      if (t.status !== 'resolved') throw conflict('INVALID_STATUS', 'Somente tickets resolvidos podem ter a resolução confirmada.');
      await setStatus(client, t, 'closed', user.id, { reason: 'Resolução confirmada pelo usuário' });
    });
    await audit({ actorId: user.id, action: 'ticket.resolution_confirmed', entityType: 'ticket', entityId: id, ip: req.ip });
    return { ok: true };
  });

  // Reabertura: permitida para tickets resolvidos ou fechados dentro do prazo configurado.
  app.post('/api/tickets/:id/reopen', async (req) => {
    const user = requireAuth(req);
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(10, 'Explique o motivo da reabertura (mínimo 10 caracteres).').max(5000) }), req.body);
    const t0 = await loadTicketForViewer(user, id, req.ip);
    if (!canViewTicketAsCustomer(user, t0)) throw forbidden();
    const windowDays = config().TICKET_REOPEN_WINDOW_DAYS;
    await withTransaction(async (client) => {
      const t = (await loadTicket(id, client, true))!;
      if (!['resolved', 'closed'].includes(t.status)) throw conflict('INVALID_STATUS', 'Somente tickets resolvidos ou fechados podem ser reabertos.');
      const ref = t.closed_at ?? t.resolved_at ?? t.updated_at;
      if (Date.now() - new Date(ref).getTime() > windowDays * 86_400_000) {
        throw conflict(
          'REOPEN_WINDOW_EXPIRED',
          `O prazo de ${windowDays} dias para reabertura expirou. Abra um novo ticket e informe o protocolo ${t.protocol} como referência.`,
        );
      }
      await client.query(`INSERT INTO ticket_messages (ticket_id, author_id, kind, body) VALUES ($1, $2, 'customer_message', $3)`, [
        id,
        user.id,
        `Solicitação de reabertura: ${sanitizePlainText(reason)}`,
      ]);
      await setStatus(client, t, 'triage', user.id, { reason: 'Reaberto pelo usuário' });
      await addEvent(client, id, user.id, 'reopened', { data: { reason: sanitizePlainText(reason, 500) } });
    });
    await audit({ actorId: user.id, action: 'ticket.reopened', entityType: 'ticket', entityId: id, ip: req.ip });
    return { ok: true };
  });

  // =========================================================================
  // Área interna de atendimento
  // =========================================================================
  app.get('/api/support/tickets', async (req) => {
    const user = requireAnyPermission(req, 'tickets.support', 'tickets.manage');
    if (user.userType !== 'internal') throw forbidden();
    const q = parse(
      z.object({
        q: z.string().max(150).optional(),
        status: z.preprocess((v) => (v === '' ? undefined : v), z.enum([...TICKET_STATUSES, 'active'] as [string, ...string[]]).optional()),
        priority: z.enum(TICKET_PRIORITIES).optional(),
        category: z.string().uuid().optional(),
        system: z.string().uuid().optional(),
        company: z.string().uuid().optional(),
        assignee: z.union([z.enum(['me', 'none']), z.string().uuid()]).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        sort: z.enum(Object.keys(SORTS) as [string, ...string[]]).default('updated_desc'),
      }).merge(pageQuery),
      req.query,
    );
    const values: unknown[] = [user.id];
    // $1 (usuário atual) é sempre referenciado para que o tipo do parâmetro seja conhecido.
    const where: string[] = ['$1::uuid IS NOT NULL'];
    // Escopo autorizado: administração vê todos; suporte vê sem responsável ou atribuídos a si.
    if (!user.permissions.has('tickets.manage')) where.push('(t.assignee_id IS NULL OR t.assignee_id = $1)');
    const add = (sql: string, v: unknown) => {
      values.push(v);
      where.push(sql.replaceAll('?', `$${values.length}`));
    };
    if (q.q) {
      add(
        `(t.protocol ILIKE '%' || ? || '%' OR immutable_unaccent(lower(t.title || ' ' || r.name || ' ' || r.email || ' ' || c.name || ' ' || s.name)) LIKE '%' || immutable_unaccent(lower(?)) || '%')`,
        q.q.trim(),
      );
    }
    if (q.status === 'active') where.push(`t.status NOT IN ('resolved', 'closed')`);
    else if (q.status) add('t.status = ?', q.status);
    if (q.priority) add('t.priority = ?', q.priority);
    if (q.category) add('t.category_id = ?', q.category);
    if (q.system) add('t.system_id = ?', q.system);
    if (q.company) add('t.company_id = ?', q.company);
    if (q.assignee === 'me') where.push('t.assignee_id = $1');
    else if (q.assignee === 'none') where.push('t.assignee_id IS NULL');
    else if (q.assignee) add('t.assignee_id = ?', q.assignee);
    const range = dateRange(q.from, q.to);
    if (range.from) add('t.created_at >= ?', range.from);
    if (range.to) add('t.created_at <= ?', range.to);
    values.push(q.pageSize, (q.page - 1) * q.pageSize);
    const rows = await query(
      `${SUMMARY_SELECT} WHERE ${where.join(' AND ')}
        ORDER BY ${SORTS[q.sort]} LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    const counts = await query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM tickets t ${user.permissions.has('tickets.manage') ? '' : 'WHERE (t.assignee_id IS NULL OR t.assignee_id = $1)'} GROUP BY status`,
      user.permissions.has('tickets.manage') ? [] : [user.id],
    );
    return {
      total: rows.length ? Number(rows[0]!.total) : 0,
      counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      items: await serializeTicketSummary(rows),
    };
  });

  // Resposta pública ao cliente ou solicitação de informações adicionais.
  app.post('/api/support/tickets/:id/reply', async (req) => {
    const user = requireAnyPermission(req, 'tickets.support', 'tickets.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const form = await readMultipart(req, { maxFiles: 10 });
    try {
      const body = parse(
        z.object({ body: z.string().trim().min(1, 'Escreva a resposta.').max(20_000), kind: z.enum(['support_reply', 'info_request']).default('support_reply') }),
        form.fields,
      );
      const t0 = await loadTicketForViewer(user, id, req.ip);
      assertSupport(user, t0);
      if (t0.status === 'closed') throw conflict('TICKET_CLOSED', 'Reabra o ticket antes de responder.');
      await prevalidateFiles(form.files, ATTACHMENT_MIME_TYPES);
      await withTransaction(async (client) => {
        const t = (await loadTicket(id, client, true))!;
        const m = await queryOne<{ id: string }>(
          `INSERT INTO ticket_messages (ticket_id, author_id, kind, body) VALUES ($1, $2, $3, $4) RETURNING id`,
          [id, user.id, body.kind, sanitizePlainText(body.body)],
          client,
        );
        await attachFiles(client, id, form.files, user.id, { messageId: m!.id });
        if (!t.assignee_id) {
          await client.query(`UPDATE tickets SET assignee_id = $2 WHERE id = $1`, [id, user.id]);
          await addEvent(client, id, user.id, 'assignment', { data: { assignee: user.name } });
        }
        if (body.kind === 'info_request') await setStatus(client, t, 'waiting_user', user.id, { reason: 'Informações adicionais solicitadas' });
        else if (['open', 'triage'].includes(t.status)) await setStatus(client, t, 'in_progress', user.id);
        await client.query(`UPDATE tickets SET updated_at = now() WHERE id = $1`, [id]);
      });
      await audit({ actorId: user.id, action: `ticket.${body.kind}`, entityType: 'ticket', entityId: id, ip: req.ip });
      return { ok: true };
    } finally {
      await form.cleanup();
    }
  });

  // Observação interna (tabela separada; nunca exibida ao cliente).
  app.post('/api/support/tickets/:id/notes', async (req) => {
    const user = requireAnyPermission(req, 'tickets.support', 'tickets.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const form = await readMultipart(req, { maxFiles: 10 });
    try {
      const { body } = parse(z.object({ body: z.string().trim().min(1, 'Escreva a observação.').max(20_000) }), form.fields);
      const t = await loadTicketForViewer(user, id, req.ip);
      assertSupport(user, t);
      await prevalidateFiles(form.files, ATTACHMENT_MIME_TYPES);
      await withTransaction(async (client) => {
        const n = await queryOne<{ id: string }>(
          `INSERT INTO ticket_internal_notes (ticket_id, author_id, body) VALUES ($1, $2, $3) RETURNING id`,
          [id, user.id, sanitizePlainText(body)],
          client,
        );
        await attachFiles(client, id, form.files, user.id, { noteId: n!.id });
      });
      await audit({ actorId: user.id, action: 'ticket.internal_note', entityType: 'ticket', entityId: id, ip: req.ip });
      return { ok: true };
    } finally {
      await form.cleanup();
    }
  });

  app.post('/api/support/tickets/:id/status', async (req) => {
    const user = requireAnyPermission(req, 'tickets.support', 'tickets.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(z.object({ status: z.enum(TICKET_STATUSES), reason: z.string().trim().max(1000).optional() }), req.body);
    const t0 = await loadTicketForViewer(user, id, req.ip);
    assertSupport(user, t0);
    await withTransaction(async (client) => {
      const t = (await loadTicket(id, client, true))!;
      if (!canSupportTransition(t.status, body.status)) {
        throw conflict('INVALID_TRANSITION', `Não é permitido alterar de "${TICKET_STATUS_LABELS[t.status]}" para "${TICKET_STATUS_LABELS[body.status as TicketStatus]}".`);
      }
      if (body.status === 'resolved' && !t.solution?.trim()) {
        throw validationError('Registre a solução aplicada antes de marcar o ticket como resolvido.', { fields: { solution: 'Solução obrigatória.' } });
      }
      if (body.status === 'closed' && t.status !== 'resolved' && !body.reason) {
        throw validationError('Informe o motivo para fechar um ticket que não foi resolvido.', { fields: { reason: 'Motivo obrigatório.' } });
      }
      await setStatus(client, t, body.status, user.id, body.reason ? { reason: sanitizePlainText(body.reason, 1000) } : {});
    });
    await audit({ actorId: user.id, action: 'ticket.status_change', entityType: 'ticket', entityId: id, data: { from: t0.status, to: body.status }, ip: req.ip });
    return { ok: true };
  });

  app.post('/api/support/tickets/:id/assign', async (req) => {
    const user = requireAnyPermission(req, 'tickets.support', 'tickets.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { assigneeId } = parse(z.object({ assigneeId: z.string().uuid().nullable() }), req.body);
    const t = await loadTicketForViewer(user, id, req.ip);
    assertSupport(user, t);
    const manage = user.permissions.has('tickets.manage');
    // Suporte pode apenas assumir tickets sem responsável; administração atribui a qualquer atendente.
    if (!manage && !(assigneeId === user.id && !t.assignee_id)) throw forbidden('Somente a administração de tickets pode atribuir a outros atendentes.');
    let assigneeName: string | null = null;
    if (assigneeId) {
      const a = await queryOne<{ name: string; user_type: string; active: boolean }>(`SELECT name, user_type, active FROM users WHERE id = $1`, [assigneeId]);
      if (!a || a.user_type !== 'internal' || !a.active) throw validationError('Atendente inválido.');
      assigneeName = a.name;
    }
    await withTransaction(async (client) => {
      await client.query(`UPDATE tickets SET assignee_id = $2, updated_at = now() WHERE id = $1`, [id, assigneeId]);
      await addEvent(client, id, user.id, 'assignment', { data: { assignee: assigneeName } });
    });
    await audit({ actorId: user.id, action: 'ticket.assign', entityType: 'ticket', entityId: id, data: { assigneeId }, ip: req.ip });
    return { ok: true };
  });

  app.put('/api/support/tickets/:id/classification', async (req) => {
    const user = requireAnyPermission(req, 'tickets.support', 'tickets.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(
      z.object({
        priority: z.enum(TICKET_PRIORITIES),
        requestType: z.enum(TICKET_REQUEST_TYPES),
        categoryId: z.string().uuid().nullable(),
        systemId: z.string().uuid(),
        title: z.string().trim().min(3).max(150),
      }),
      req.body,
    );
    const t = await loadTicketForViewer(user, id, req.ip);
    assertSupport(user, t);
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE tickets SET priority = $2, request_type = $3, category_id = $4, system_id = $5, title = $6, updated_at = now() WHERE id = $1`,
        [id, body.priority, body.requestType, body.categoryId, body.systemId, sanitizePlainText(body.title, 150)],
      );
      await addEvent(client, id, user.id, 'classification', {
        data: { before: { priority: t.priority, requestType: t.request_type, categoryId: t.category_id, systemId: t.system_id, title: t.title }, after: body },
        isPublic: false,
      });
    });
    return { ok: true };
  });

  // Registro da análise, procedimentos, solução e orientações (opcionalmente resolve o ticket).
  app.put('/api/support/tickets/:id/resolution', async (req) => {
    const user = requireAnyPermission(req, 'tickets.support', 'tickets.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const body = parse(
      z.object({
        analysisResult: z.string().trim().max(10_000).default(''),
        procedures: z.string().trim().max(10_000).default(''),
        solution: z.string().trim().max(10_000).default(''),
        guidance: z.string().trim().max(10_000).default(''),
        resolve: z.boolean().default(false),
      }),
      req.body,
    );
    const t0 = await loadTicketForViewer(user, id, req.ip);
    assertSupport(user, t0);
    if (body.resolve && !body.solution) throw validationError('Informe a solução aplicada para resolver o ticket.', { fields: { solution: 'Solução obrigatória.' } });
    await withTransaction(async (client) => {
      const t = (await loadTicket(id, client, true))!;
      await client.query(
        `UPDATE tickets SET analysis_result = $2, procedures = $3, solution = $4, guidance = $5, updated_at = now() WHERE id = $1`,
        [id, sanitizePlainText(body.analysisResult) || null, sanitizePlainText(body.procedures) || null, sanitizePlainText(body.solution) || null, sanitizePlainText(body.guidance) || null],
      );
      await addEvent(client, id, user.id, 'resolution_updated', { isPublic: false });
      if (body.resolve) {
        if (!canSupportTransition(t.status, 'resolved')) throw conflict('INVALID_TRANSITION', `Não é possível resolver um ticket com status "${TICKET_STATUS_LABELS[t.status]}".`);
        const parts = [
          body.analysisResult && `Resultado da análise:\n${body.analysisResult}`,
          body.procedures && `Procedimentos executados:\n${body.procedures}`,
          `Solução aplicada:\n${body.solution}`,
          body.guidance && `Orientações complementares:\n${body.guidance}`,
        ].filter(Boolean);
        await client.query(`INSERT INTO ticket_messages (ticket_id, author_id, kind, body) VALUES ($1, $2, 'solution', $3)`, [
          id,
          user.id,
          sanitizePlainText(parts.join('\n\n')),
        ]);
        if (!t.assignee_id) await client.query(`UPDATE tickets SET assignee_id = $2 WHERE id = $1`, [id, user.id]);
        await setStatus(client, t, 'resolved', user.id);
      }
    });
    await audit({ actorId: user.id, action: body.resolve ? 'ticket.resolved' : 'ticket.resolution_updated', entityType: 'ticket', entityId: id, ip: req.ip });
    return { ok: true };
  });

  // Relacionar artigos da Base de Conhecimento ao ticket.
  app.post('/api/support/tickets/:id/articles', async (req) => {
    const user = requireAnyPermission(req, 'tickets.support', 'tickets.manage');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const { articleId } = parse(z.object({ articleId: uuid }), req.body);
    const t = await loadTicketForViewer(user, id, req.ip);
    assertSupport(user, t);
    const a = await queryOne<{ id: string; title: string; status: string; visibility: string; author_id: string }>(
      `SELECT id, title, status, visibility, author_id FROM articles WHERE id = $1`,
      [articleId],
    );
    if (!a || !canViewArticle(user, a)) throw notFound('Artigo não encontrado.');
    await withTransaction(async (client) => {
      await client.query(`INSERT INTO ticket_articles (ticket_id, article_id, linked_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [id, articleId, user.id]);
      // O cliente só vê o vínculo se o artigo for externo e publicado.
      await addEvent(client, id, user.id, 'article_linked', {
        data: { articleId, title: a.title },
        isPublic: a.status === 'published' && a.visibility === 'external',
      });
    });
    return { ok: true };
  });

  app.delete('/api/support/tickets/:id/articles/:articleId', async (req) => {
    const user = requireAnyPermission(req, 'tickets.support', 'tickets.manage');
    const { id, articleId } = parse(z.object({ id: uuid, articleId: uuid }), req.params);
    const t = await loadTicketForViewer(user, id, req.ip);
    assertSupport(user, t);
    await query(`DELETE FROM ticket_articles WHERE ticket_id = $1 AND article_id = $2`, [id, articleId]);
    await addEvent(getPool(), id, user.id, 'article_unlinked', { data: { articleId }, isPublic: false });
    return { ok: true };
  });

  // Sugere a criação de um artigo a partir da solução validada (rascunho interno, sem dados pessoais).
  app.post('/api/support/tickets/:id/suggest-article', async (req, reply) => {
    const user = requirePermission(req, 'articles.create');
    const { id } = parse(z.object({ id: uuid }), req.params);
    const t = await loadTicketForViewer(user, id, req.ip);
    assertSupport(user, t);
    if (!t.solution?.trim()) throw validationError('Registre a solução do ticket antes de sugerir um artigo.');
    const section = (title: string, text: string | null) =>
      text?.trim() ? `<h2>${escapeHtml(title)}</h2>${text.trim().split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('')}` : '';
    const html = [
      `<div data-callout="info"><p>Rascunho gerado a partir de uma solução validada no atendimento. Revise o conteúdo e remova quaisquer dados de clientes antes de publicar.</p></div>`,
      section('Problema', t.title),
      section('Análise', t.analysis_result),
      section('Procedimento', t.procedures),
      section('Solução', t.solution),
      section('Orientações', t.guidance),
    ].join('');
    const article = await withTransaction(async (client) => {
      const a = await createArticle(
        user,
        {
          title: `Solução: ${t.title}`.slice(0, 200),
          summary: truncate(t.solution!.replace(/\s+/g, ' '), 300),
          contentHtml: html,
          categoryId: t.category_id,
          systemId: t.system_id,
          keywords: [slugify(t.title).split('-').slice(0, 3).join(' ')].filter(Boolean),
          tags: [],
          visibility: 'internal',
        },
        client,
      );
      await client.query(`INSERT INTO ticket_articles (ticket_id, article_id, linked_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [id, a.id, user.id]);
      await addEvent(client, id, user.id, 'article_suggested', { data: { articleId: a.id }, isPublic: false });
      return a;
    });
    reply.code(201);
    return { article: { id: article.id, slug: article.slug } };
  });

  // Lista de artigos para vincular (pesquisa simples por título, respeitando a visibilidade).
  app.get('/api/support/article-picker', async (req) => {
    const user = requireAnyPermission(req, 'tickets.support', 'tickets.manage');
    const { q } = parse(z.object({ q: z.string().max(100).default('') }), req.query);
    const rows = await query(
      `SELECT id, title, slug, status, visibility FROM articles
        WHERE status = 'published' AND visibility = ANY($1::text[])
          AND immutable_unaccent(lower(title)) LIKE '%' || immutable_unaccent(lower($2)) || '%'
        ORDER BY updated_at DESC LIMIT 20`,
      [allowedVisibilities(user), q],
    );
    return { items: rows };
  });
}
