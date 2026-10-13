import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { config } from '../../config.js';
import { getPool, query, queryOne, withTransaction } from '../../db/pool.js';
import { requirePermission, type AuthUser } from '../../auth/context.js';
import { audit } from '../../lib/audit.js';
import { AppError, conflict, notFound, validationError } from '../../lib/errors.js';
import { dateRange, pageQuery, parse, uuid } from '../../lib/validate.js';

/**
 * Integração de Clientes: cards de acompanhamento, atividades e histórico de alterações.
 * Cada gravação do card e seus registros de auditoria ocorrem na MESMA transação; a versão do
 * registro (optimistic locking) impede que uma edição concorrente sobrescreva dados mais novos.
 * Textos são armazenados como texto simples (o React os escapa na exibição: sem HTML, sem XSS).
 */

export const INTEGRATION_STATUSES = ['inicio', 'acompanhamento', 'finalizado'] as const;
type Status = (typeof INTEGRATION_STATUSES)[number];
const STATUS_LABEL: Record<string, string> = { inicio: 'Início', acompanhamento: 'Acompanhamento', finalizado: 'Finalizado' };

type Db = pg.Pool | pg.PoolClient;

// --- Validação -------------------------------------------------------------------------
const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const text = (max: number, label: string) => z.string().trim().min(1, `Informe ${label}.`).max(max, `${label} excede ${max} caracteres.`);
const optText = (max: number) => z.preprocess(emptyToNull, z.string().trim().max(max).nullable().optional());
const dateStr = z.preprocess(
  emptyToNull,
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.')
    .refine((s) => !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime()) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'Data inválida.')
    .nullable()
    .optional(),
);
const optUuid = z.preprocess(emptyToNull, z.string().uuid('Identificador inválido.').nullable().optional());

const fieldsSchema = z.object({
  companyId: z.string().uuid('Selecione a empresa.'),
  systemId: z.string().uuid('Selecione o TMS.'),
  objective: text(2000, 'o objetivo'),
  csGcId: z.string().uuid('Selecione o CS/GC da conta.'),
  operatorId: optUuid,
  description: text(20000, 'a descrição'),
  status: z.enum(INTEGRATION_STATUSES, { errorMap: () => ({ message: 'Status inválido.' }) }),
  startedOn: dateStr,
  expectedEndOn: dateStr,
  finishedOn: dateStr,
  nextAction: optText(2000),
  nextActionOwnerId: optUuid,
  nextActionDue: dateStr,
  nextActionNotes: optText(4000),
  notes: optText(10000),
});
type Fields = z.infer<typeof fieldsSchema>;
type FieldKey = keyof Fields;

interface FieldDef {
  key: FieldKey;
  col: string;
  label: string;
  /** Valor legível (nomes no lugar de IDs) a partir da linha com joins. */
  display: (r: Row) => string | null;
  raw: (r: Row) => string | null;
}
type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

const FIELDS: FieldDef[] = [
  { key: 'companyId', col: 'company_id', label: 'Empresa', raw: (r) => s(r.company_id), display: (r) => s(r.company_name) },
  { key: 'systemId', col: 'system_id', label: 'TMS', raw: (r) => s(r.system_id), display: (r) => s(r.system_name) },
  { key: 'objective', col: 'objective', label: 'Objetivo', raw: (r) => s(r.objective), display: (r) => s(r.objective) },
  { key: 'csGcId', col: 'cs_gc_id', label: 'CS/GC da conta', raw: (r) => s(r.cs_gc_id), display: (r) => s(r.cs_name) },
  { key: 'operatorId', col: 'operator_id', label: 'Responsável operacional', raw: (r) => s(r.operator_id), display: (r) => s(r.operator_name) },
  { key: 'description', col: 'description', label: 'Descrição', raw: (r) => s(r.description), display: (r) => s(r.description) },
  { key: 'status', col: 'status', label: 'Status', raw: (r) => s(r.status), display: (r) => (r.status ? (STATUS_LABEL[r.status as string] ?? s(r.status)) : null) },
  { key: 'startedOn', col: 'started_on', label: 'Data de início', raw: (r) => s(r.started_on), display: (r) => s(r.started_on) },
  { key: 'expectedEndOn', col: 'expected_end_on', label: 'Data prevista para conclusão', raw: (r) => s(r.expected_end_on), display: (r) => s(r.expected_end_on) },
  { key: 'finishedOn', col: 'finished_on', label: 'Data de finalização', raw: (r) => s(r.finished_on), display: (r) => s(r.finished_on) },
  { key: 'nextAction', col: 'next_action', label: 'Próxima ação', raw: (r) => s(r.next_action), display: (r) => s(r.next_action) },
  { key: 'nextActionOwnerId', col: 'next_action_owner_id', label: 'Responsável pela próxima ação', raw: (r) => s(r.next_action_owner_id), display: (r) => s(r.owner_name) },
  { key: 'nextActionDue', col: 'next_action_due', label: 'Data prevista da próxima ação', raw: (r) => s(r.next_action_due), display: (r) => s(r.next_action_due) },
  { key: 'nextActionNotes', col: 'next_action_notes', label: 'Observações da próxima ação', raw: (r) => s(r.next_action_notes), display: (r) => s(r.next_action_notes) },
  { key: 'notes', col: 'notes', label: 'Observações gerais', raw: (r) => s(r.notes), display: (r) => s(r.notes) },
];
const FINISH_FIELDS: Array<{ col: string; label: string; key: string }> = [
  { col: 'result_summary', label: 'Resumo do resultado', key: 'resultSummary' },
  { col: 'final_notes', label: 'Observações finais', key: 'finalNotes' },
  { col: 'remaining_pending', label: 'Pendências remanescentes', key: 'remainingPending' },
];

export const FIELD_LABELS: Record<string, string> = {
  ...Object.fromEntries(FIELDS.map((f) => [f.key, f.label])),
  resultSummary: 'Resumo do resultado',
  finalNotes: 'Observações finais',
  remainingPending: 'Pendências remanescentes',
  reopenReason: 'Motivo da reabertura',
  archived: 'Arquivamento',
};

// --- Acesso a dados ------------------------------------------------------------------
function tzLiteral(): string {
  const tz = config().APP_TIMEZONE;
  if (!/^[A-Za-z_/+-]+$/.test(tz)) throw new Error('APP_TIMEZONE inválido.');
  return tz;
}

const SELECT_ROW = () => `
  SELECT i.id, i.company_id, c.name AS company_name, i.system_id, sy.name AS system_name, i.objective, i.description,
         i.cs_gc_id, cs.name AS cs_name, i.operator_id, op.name AS operator_name, i.status,
         i.started_on::text AS started_on, i.expected_end_on::text AS expected_end_on, i.finished_on::text AS finished_on,
         i.next_action, i.next_action_owner_id, ow.name AS owner_name, i.next_action_due::text AS next_action_due, i.next_action_notes, i.notes,
         i.result_summary, i.final_notes, i.remaining_pending, i.finished_by, fb.name AS finished_by_name,
         i.archived_at, i.created_by, cb.name AS created_by_name, i.created_at, i.updated_at, i.version,
         (i.next_action_due IS NOT NULL AND i.next_action_due < (now() AT TIME ZONE '${tzLiteral()}')::date AND i.status <> 'finalizado' AND i.archived_at IS NULL) AS overdue
    FROM customer_integrations i
    JOIN companies c ON c.id = i.company_id
    JOIN systems sy ON sy.id = i.system_id
    JOIN users cs ON cs.id = i.cs_gc_id
    JOIN users cb ON cb.id = i.created_by
    LEFT JOIN users op ON op.id = i.operator_id
    LEFT JOIN users ow ON ow.id = i.next_action_owner_id
    LEFT JOIN users fb ON fb.id = i.finished_by`;

async function fetchRow(id: string, db: Db, lock = false): Promise<Row | null> {
  if (lock) await db.query(`SELECT 1 FROM customer_integrations WHERE id = $1 FOR UPDATE`, [id]);
  const r = await db.query(`${SELECT_ROW()} WHERE i.id = $1`, [id]);
  return (r.rows[0] as Row) ?? null;
}

function serialize(r: Row, detail = true) {
  const base = {
    id: r.id,
    company: { id: r.company_id, name: r.company_name },
    system: { id: r.system_id, name: r.system_name },
    objective: r.objective,
    csGc: { id: r.cs_gc_id, name: r.cs_name },
    operator: r.operator_id ? { id: r.operator_id, name: r.operator_name } : null,
    status: r.status,
    startedOn: r.started_on,
    expectedEndOn: r.expected_end_on,
    finishedOn: r.finished_on,
    nextAction: r.next_action,
    nextActionOwner: r.next_action_owner_id ? { id: r.next_action_owner_id, name: r.owner_name } : null,
    nextActionDue: r.next_action_due,
    overdue: r.overdue,
    archived: !!r.archived_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    version: r.version,
  };
  if (!detail) return base;
  return {
    ...base,
    description: r.description,
    nextActionNotes: r.next_action_notes,
    notes: r.notes,
    resultSummary: r.result_summary,
    finalNotes: r.final_notes,
    remainingPending: r.remaining_pending,
    finishedBy: r.finished_by ? { id: r.finished_by, name: r.finished_by_name } : null,
    archivedAt: r.archived_at,
    createdBy: { id: r.created_by, name: r.created_by_name },
  };
}

async function assertRefs(db: Db, f: Partial<Fields>): Promise<void> {
  const errors: Record<string, string> = {};
  const check = async (key: string, sql: string, id: string | null | undefined, msg: string) => {
    if (!id) return;
    const r = await db.query(sql, [id]);
    if (!r.rows.length) errors[key] = msg;
  };
  await check('companyId', `SELECT 1 FROM companies WHERE id = $1 AND active`, f.companyId, 'Empresa inválida.');
  await check('systemId', `SELECT 1 FROM systems WHERE id = $1 AND active`, f.systemId, 'TMS inválido.');
  const internal = `SELECT 1 FROM users WHERE id = $1 AND active AND user_type = 'internal'`;
  await check('csGcId', internal, f.csGcId, 'CS/GC inválido.');
  await check('operatorId', internal, f.operatorId, 'Responsável inválido.');
  await check('nextActionOwnerId', internal, f.nextActionOwnerId, 'Responsável inválido.');
  if (Object.keys(errors).length) throw validationError('Dados inválidos.', { fields: errors });
}

function assertDates(started?: string | null, expected?: string | null): void {
  if (started && expected && expected < started) {
    throw validationError('A data prevista não pode ser anterior à data de início.', { fields: { expectedEndOn: 'A data prevista não pode ser anterior à data de início.' } });
  }
}

interface ChangeRow {
  field: string;
  old: string | null;
  neu: string | null;
  type: string;
}
async function writeChanges(db: Db, integrationId: string, operationId: string, user: AuthUser, rows: ChangeRow[]): Promise<void> {
  for (const c of rows) {
    await db.query(
      `INSERT INTO integration_changes (integration_id, operation_id, operation_type, user_id, user_name, field_name, old_value, new_value)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [integrationId, operationId, c.type, user.id, user.name, c.field, c.old, c.neu],
    );
  }
}

function conflictError(row: Row): AppError {
  return conflict('VERSION_CONFLICT', 'Este card foi atualizado por outra pessoa. Recarregue os dados atuais antes de alterar novamente.', { current: serialize(row) });
}

const like = (v: string) => `%${v.replace(/[\\%_]/g, '\\$&')}%`;
const csv = z.string().max(300).optional().transform((v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 10) : []));

export default async function integrationRoutes(app: FastifyInstance): Promise<void> {
  const idParam = z.object({ id: uuid });

  // ---- Referências para formulários e filtros ----------------------------------------
  app.get('/api/integrations/lookups', async (req) => {
    requirePermission(req, 'integrations.view');
    const [companies, systems, users, types] = await Promise.all([
      query(`SELECT id, name FROM companies WHERE active ORDER BY name`),
      query(`SELECT id, name FROM systems WHERE active ORDER BY name`),
      query(`SELECT id, name FROM users WHERE active AND user_type = 'internal' ORDER BY name`),
      query(`SELECT id, name, active FROM integration_activity_types ORDER BY sort_order, name`),
    ]);
    return { companies, systems, users, activityTypes: types.filter((t) => t.active).map((t) => ({ id: t.id, name: t.name })), allActivityTypes: types };
  });

  // ---- Tipos de atividade (configuráveis) --------------------------------------------
  app.post('/api/integrations/activity-types', async (req, reply) => {
    const user = requirePermission(req, 'integrations.admin');
    const body = parse(z.object({ name: text(80, 'o nome') }), req.body);
    try {
      const row = await queryOne(`INSERT INTO integration_activity_types (name, sort_order) VALUES ($1, 200) RETURNING id, name, active`, [body.name]);
      await audit({ actorId: user.id, action: 'integration.activity_type_create', entityType: 'integration_activity_type', entityId: row!.id as string, data: body, ip: req.ip });
      reply.code(201);
      return { type: row };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict('DUPLICATE', 'Já existe um tipo de atividade com este nome.');
      throw err;
    }
  });
  app.put('/api/integrations/activity-types/:id', async (req) => {
    const user = requirePermission(req, 'integrations.admin');
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ name: text(80, 'o nome').optional(), active: z.boolean().optional() }), req.body);
    try {
      const row = await queryOne(`UPDATE integration_activity_types SET name = coalesce($2, name), active = coalesce($3, active) WHERE id = $1 RETURNING id, name, active`, [id, body.name ?? null, body.active ?? null]);
      if (!row) throw notFound('Tipo de atividade não encontrado.');
      await audit({ actorId: user.id, action: 'integration.activity_type_update', entityType: 'integration_activity_type', entityId: id, data: body, ip: req.ip });
      return { type: row };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict('DUPLICATE', 'Já existe um tipo de atividade com este nome.');
      throw err;
    }
  });

  // ---- Listagem + indicadores ----------------------------------------------------------
  app.get('/api/integrations', async (req) => {
    const user = requirePermission(req, 'integrations.view');
    const q = parse(
      z
        .object({
          q: z.string().max(200).optional(),
          status: csv,
          companyId: z.string().uuid().optional(),
          systemId: z.string().uuid().optional(),
          csGcId: z.string().uuid().optional(),
          operatorId: z.string().uuid().optional(),
          createdFrom: z.string().optional(),
          createdTo: z.string().optional(),
          expectedFrom: z.string().optional(),
          expectedTo: z.string().optional(),
          updatedFrom: z.string().optional(),
          updatedTo: z.string().optional(),
          overdue: z.enum(['1']).optional(),
          archived: z.enum(['0', '1']).default('0'),
          sort: z.enum(['updated', 'created', 'company', 'status', 'expected']).default('updated'),
          dir: z.enum(['asc', 'desc']).default('desc'),
        })
        .merge(pageQuery),
      req.query,
    );
    for (const st of q.status) if (!(INTEGRATION_STATUSES as readonly string[]).includes(st)) throw validationError('Status inválido.');
    const values: unknown[] = [];
    const where: string[] = [];
    const add = (sql: string, v: unknown) => {
      values.push(v);
      where.push(sql.replaceAll('?', `$${values.length}`));
    };
    const showArchived = q.archived === '1' && user.permissions.has('integrations.archive');
    where.push(showArchived ? 'i.archived_at IS NOT NULL' : 'i.archived_at IS NULL');
    if (q.q) {
      add(
        `(unaccent(c.name) ILIKE unaccent(?) OR unaccent(sy.name) ILIKE unaccent(?) OR unaccent(i.objective) ILIKE unaccent(?)
          OR unaccent(cs.name) ILIKE unaccent(?) OR unaccent(coalesce(op.name,'')) ILIKE unaccent(?))`,
        like(q.q),
      );
    }
    if (q.status.length) add('i.status = ANY(?::text[])', q.status);
    if (q.companyId) add('i.company_id = ?', q.companyId);
    if (q.systemId) add('i.system_id = ?', q.systemId);
    if (q.csGcId) add('i.cs_gc_id = ?', q.csGcId);
    if (q.operatorId) add('i.operator_id = ?', q.operatorId);
    const created = dateRange(q.createdFrom, q.createdTo);
    if (created.from) add('i.created_at >= ?', created.from);
    if (created.to) add('i.created_at <= ?', created.to);
    const updated = dateRange(q.updatedFrom, q.updatedTo);
    if (updated.from) add('i.updated_at >= ?', updated.from);
    if (updated.to) add('i.updated_at <= ?', updated.to);
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
    if (q.expectedFrom && dateOnly.test(q.expectedFrom)) add('i.expected_end_on >= ?::date', q.expectedFrom);
    if (q.expectedTo && dateOnly.test(q.expectedTo)) add('i.expected_end_on <= ?::date', q.expectedTo);
    if (q.overdue) where.push(`i.next_action_due IS NOT NULL AND i.next_action_due < (now() AT TIME ZONE '${tzLiteral()}')::date AND i.status <> 'finalizado'`);
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
    const order = {
      updated: `i.updated_at ${dir}`,
      created: `i.created_at ${dir}`,
      company: `lower(c.name) ${dir}`,
      status: `(CASE i.status WHEN 'inicio' THEN 1 WHEN 'acompanhamento' THEN 2 ELSE 3 END) ${dir}, i.updated_at DESC`,
      expected: `i.expected_end_on ${dir} NULLS LAST`,
    }[q.sort];
    const from = `FROM customer_integrations i JOIN companies c ON c.id = i.company_id JOIN systems sy ON sy.id = i.system_id JOIN users cs ON cs.id = i.cs_gc_id LEFT JOIN users op ON op.id = i.operator_id`;
    const total = await queryOne<{ n: string }>(`SELECT count(*) AS n ${from} ${whereSql}`, values);
    const rowsRes = await query<{ id: string }>(`SELECT i.id ${from} ${whereSql} ORDER BY ${order}, i.id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, q.pageSize, (q.page - 1) * q.pageSize]);
    const ids = rowsRes.map((r) => r.id);
    const full = ids.length ? await query(`${SELECT_ROW()} WHERE i.id = ANY($1::uuid[])`, [ids]) : [];
    const byId = new Map(full.map((r) => [r.id as string, r]));
    const stats = await queryOne<Record<string, number>>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'inicio')::int AS inicio,
              count(*) FILTER (WHERE status = 'acompanhamento')::int AS acompanhamento,
              count(*) FILTER (WHERE status = 'finalizado')::int AS finalizado,
              count(*) FILTER (WHERE next_action_due IS NOT NULL AND next_action_due < (now() AT TIME ZONE '${tzLiteral()}')::date AND status <> 'finalizado')::int AS overdue
         FROM customer_integrations WHERE archived_at IS NULL`,
    );
    return { total: Number(total?.n ?? 0), items: ids.map((id) => serialize(byId.get(id)!, false)), stats };
  });

  // ---- Criação -----------------------------------------------------------------------
  app.post('/api/integrations', async (req, reply) => {
    const user = requirePermission(req, 'integrations.create');
    const body = parse(fieldsSchema.extend({ status: z.enum(['inicio', 'acompanhamento']).default('inicio'), finishedOn: z.undefined().optional(), requestId: z.string().uuid().optional() }), req.body);
    assertDates(body.startedOn, body.expectedEndOn);
    const token = body.requestId ?? null;
    const result = await withTransaction(async (client) => {
      await assertRefs(client, body);
      const ins = await client.query(
        `INSERT INTO customer_integrations (company_id, system_id, objective, description, cs_gc_id, operator_id, status, started_on, expected_end_on,
                next_action, next_action_owner_id, next_action_due, next_action_notes, notes, created_by, create_token)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (create_token) DO NOTHING RETURNING id`,
        [body.companyId, body.systemId, body.objective, body.description, body.csGcId, body.operatorId ?? null, body.status, body.startedOn ?? null, body.expectedEndOn ?? null,
         body.nextAction ?? null, body.nextActionOwnerId ?? null, body.nextActionDue ?? null, body.nextActionNotes ?? null, body.notes ?? null, user.id, token],
      );
      if (!ins.rows.length) {
        const existing = await client.query(`SELECT id FROM customer_integrations WHERE create_token = $1`, [token]);
        return { id: existing.rows[0].id as string, duplicate: true };
      }
      const id = ins.rows[0].id as string;
      const row = (await fetchRow(id, client))!;
      const ops = FIELDS.filter((f) => f.raw(row) !== null).map((f) => ({ field: f.key, old: null, neu: f.display(row), type: 'create' }));
      await writeChanges(client, id, randomUUID(), user, ops);
      await audit({ actorId: user.id, action: 'integration.create', entityType: 'customer_integration', entityId: id, data: { company: row.company_name, system: row.system_name }, ip: req.ip }, client);
      return { id, duplicate: false };
    });
    reply.code(result.duplicate ? 200 : 201);
    return { integration: serialize((await fetchRow(result.id, getPool()))!), duplicate: result.duplicate };
  });

  // ---- Detalhe -----------------------------------------------------------------------
  app.get('/api/integrations/:id', async (req) => {
    requirePermission(req, 'integrations.view');
    const { id } = parse(idParam, req.params);
    
    const row = await fetchRow(id, getPool());
    if (!row) throw notFound('Integração não encontrada.');
    return { integration: serialize(row) };
  });

  // ---- Alteração dos dados cadastrais ----------------------------------------------------
  app.put('/api/integrations/:id', async (req) => {
    const user = requirePermission(req, 'integrations.edit');
    const { id } = parse(idParam, req.params);
    const body = parse(fieldsSchema.partial().extend({ version: z.number().int().min(1, 'Versão obrigatória.') }), req.body);
    const out = await withTransaction(async (client) => {
      const before = await fetchRow(id, client, true);
      if (!before) throw notFound('Integração não encontrada.');
      if (before.version !== body.version) throw conflictError(before);
      if (before.archived_at) throw conflict('ARCHIVED', 'Integração arquivada: restaure-a antes de alterar.');

      // Campos efetivamente modificados (comparação com o valor persistido)
      const changed: Array<{ def: FieldDef; value: unknown }> = [];
      for (const def of FIELDS) {
        if (!(def.key in body)) continue;
        const incoming = (body as Record<string, unknown>)[def.key];
        const norm = incoming === undefined || incoming === null || incoming === '' ? null : String(incoming);
        if (norm !== def.raw(before)) changed.push({ def, value: incoming ?? null });
      }
      if (!changed.length) return { id, changed: false };

      const has = (k: FieldKey) => changed.some((c) => c.def.key === k);
      if (has('status')) {
        requirePermission(req, 'integrations.status');
        const from = before.status as Status;
        const to = body.status as Status;
        if (to === 'finalizado') throw validationError('Para finalizar use a ação "Finalizar", que registra o resultado.', { fields: { status: 'Use a ação Finalizar.' } });
        if (from === 'finalizado') throw validationError('Para reabrir uma integração finalizada use a ação "Reabrir".', { fields: { status: 'Use a ação Reabrir.' } });
      }
      if (has('finishedOn')) {
        requirePermission(req, 'integrations.finish');
        if (before.status !== 'finalizado') throw validationError('A data de finalização só pode ser alterada em integrações finalizadas.', { fields: { finishedOn: 'Integração não finalizada.' } });
        if (!body.finishedOn) throw validationError('Informe a data de finalização.', { fields: { finishedOn: 'Informe a data de finalização.' } });
      }
      const merged = { ...Object.fromEntries(FIELDS.map((f) => [f.key, f.raw(before)])), ...Object.fromEntries(changed.map((c) => [c.def.key, c.value])) } as Record<string, string | null>;
      assertDates(merged.startedOn, merged.expectedEndOn);
      await assertRefs(client, Object.fromEntries(changed.map((c) => [c.def.key, c.value])) as Partial<Fields>);

      const sets = changed.map((c, i) => `${c.def.col} = $${i + 3}`);
      const res = await client.query(`UPDATE customer_integrations SET ${sets.join(', ')}, updated_at = now(), version = version + 1 WHERE id = $1 AND version = $2 RETURNING id`, [
        id, body.version, ...changed.map((c) => c.value),
      ]);
      if (!res.rows.length) throw conflictError((await fetchRow(id, client))!);
      const after = (await fetchRow(id, client))!;
      const operationId = randomUUID();
      await writeChanges(client, id, operationId, user, changed.map((c) => ({ field: c.def.key, old: c.def.display(before), neu: c.def.display(after), type: c.def.key === 'status' ? 'status_change' : 'update' })));
      await audit({ actorId: user.id, action: 'integration.update', entityType: 'customer_integration', entityId: id, data: { operationId, fields: changed.map((c) => c.def.key), statusFrom: has('status') ? before.status : undefined, statusTo: has('status') ? after.status : undefined }, ip: req.ip }, client);
      return { id, changed: true };
    });
    
    return { integration: serialize((await fetchRow(out.id, getPool()))!), changed: out.changed };
  });

  // ---- Finalizar / reabrir / arquivar / restaurar --------------------------------------------
  const transition = <S extends z.ZodTypeAny>(
    path: string,
    perm: Parameters<typeof requirePermission>[1],
    schema: S,
    run: (ctx: { client: pg.PoolClient; before: Row; body: z.infer<S>; user: AuthUser; operationId: string }) => Promise<{ sets: Record<string, unknown>; changes: ChangeRow[]; action: string; data?: Record<string, unknown> }>,
  ) =>
    app.post(`/api/integrations/:id/${path}`, async (req) => {
      const user = requirePermission(req, perm);
      const { id } = parse(idParam, req.params);
      const body = parse(schema, req.body);
      await withTransaction(async (client) => {
        const before = await fetchRow(id, client, true);
        if (!before) throw notFound('Integração não encontrada.');
        if (before.version !== (body as { version: number }).version) throw conflictError(before);
        const operationId = randomUUID();
        const { sets, changes, action, data } = await run({ client, before, body, user, operationId });
        const cols = Object.keys(sets);
        const r = await client.query(`UPDATE customer_integrations SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}${cols.length ? ',' : ''} updated_at = now(), version = version + 1 WHERE id = $1 AND version = $2 RETURNING id`, [id, (body as { version: number }).version, ...cols.map((c) => sets[c])]);
        if (!r.rows.length) throw conflictError((await fetchRow(id, client))!);
        await writeChanges(client, id, operationId, user, changes);
        await audit({ actorId: user.id, action, entityType: 'customer_integration', entityId: id, data: { operationId, ...data }, ip: req.ip }, client);
      });
      
      return { integration: serialize((await fetchRow(id, getPool()))!) };
    });

  const diffRow = (before: Row, after: Record<string, unknown>, defs: Array<{ col: string; key: string }>, type: string): ChangeRow[] =>
    defs.filter((d) => s(before[d.col]) !== s(after[d.col])).map((d) => ({ field: d.key, old: s(before[d.col]), neu: s(after[d.col]), type }));

  transition(
    'finish', 'integrations.finish',
    z.object({
      version: z.number().int().min(1),
      confirm: z.literal(true, { errorMap: () => ({ message: 'Confirme a finalização.' }) }),
      finishedOn: dateStr,
      resultSummary: text(10000, 'o resumo do resultado'),
      finalNotes: optText(10000),
      remainingPending: optText(10000),
    }),
    async ({ before, body, user }) => {
      if (before.archived_at) throw conflict('ARCHIVED', 'Integração arquivada: restaure-a antes de alterar.');
      if (before.status === 'finalizado') throw conflict('ALREADY_FINISHED', 'A integração já está finalizada.');
      const [{ today }] = (await query<{ today: string }>(`SELECT (now() AT TIME ZONE '${tzLiteral()}')::date::text AS today`)) as Array<{ today: string }>;
      const finishedOn = body.finishedOn ?? today;
      if (before.started_on && finishedOn < (before.started_on as string)) throw validationError('A data de finalização não pode ser anterior ao início.', { fields: { finishedOn: 'Anterior ao início.' } });
      const sets = { status: 'finalizado', finished_on: finishedOn, result_summary: body.resultSummary, final_notes: body.finalNotes ?? null, remaining_pending: body.remainingPending ?? null, finished_by: user.id };
      const changes: ChangeRow[] = [
        { field: 'status', old: STATUS_LABEL[before.status as string] ?? null, neu: STATUS_LABEL.finalizado!, type: 'finish' },
        { field: 'finishedOn', old: s(before.finished_on), neu: finishedOn, type: 'finish' },
        ...diffRow(before, { result_summary: sets.result_summary, final_notes: sets.final_notes, remaining_pending: sets.remaining_pending }, FINISH_FIELDS, 'finish'),
      ];
      return { sets, changes, action: 'integration.finish', data: { statusFrom: before.status, statusTo: 'finalizado' } };
    },
  );

  transition(
    'reopen', 'integrations.reopen',
    z.object({ version: z.number().int().min(1), reason: text(2000, 'o motivo da reabertura').refine((v) => v.length >= 5, 'Descreva o motivo da reabertura.'), status: z.enum(['inicio', 'acompanhamento']).default('acompanhamento') }),
    async ({ before, body }) => {
      if (before.archived_at) throw conflict('ARCHIVED', 'Integração arquivada: restaure-a antes de alterar.');
      if (before.status !== 'finalizado') throw conflict('NOT_FINISHED', 'Somente integrações finalizadas podem ser reabertas.');
      // Os dados da finalização anterior são limpos do card, mas ficam preservados no histórico de alterações.
      const sets = { status: body.status, finished_on: null, result_summary: null, final_notes: null, remaining_pending: null, finished_by: null };
      const changes: ChangeRow[] = [
        { field: 'status', old: STATUS_LABEL.finalizado!, neu: STATUS_LABEL[body.status]!, type: 'reopen' },
        { field: 'reopenReason', old: null, neu: body.reason, type: 'reopen' },
        { field: 'finishedOn', old: s(before.finished_on), neu: null, type: 'reopen' },
        ...diffRow(before, { result_summary: null, final_notes: null, remaining_pending: null }, FINISH_FIELDS, 'reopen'),
      ];
      return { sets, changes, action: 'integration.reopen', data: { statusFrom: 'finalizado', statusTo: body.status, reason: body.reason } };
    },
  );

  transition('archive', 'integrations.archive', z.object({ version: z.number().int().min(1), reason: optText(1000) }), async ({ before, user }) => {
    if (before.archived_at) throw conflict('ARCHIVED', 'A integração já está arquivada.');
    const now = new Date().toISOString();
    return { sets: { archived_at: now, archived_by: user.id }, changes: [{ field: 'archived', old: null, neu: now, type: 'archive' }], action: 'integration.archive' };
  });
  transition('restore', 'integrations.archive', z.object({ version: z.number().int().min(1) }), async ({ before }) => {
    if (!before.archived_at) throw conflict('NOT_ARCHIVED', 'A integração não está arquivada.');
    return { sets: { archived_at: null, archived_by: null }, changes: [{ field: 'archived', old: new Date(before.archived_at as Date).toISOString(), neu: null, type: 'restore' }], action: 'integration.restore' };
  });

  // ---- Histórico do acompanhamento (atividades) ---------------------------------------------
  const serializeActivity = (a: Row) => ({
    id: a.id, typeId: a.type_id, type: a.type_name, description: a.description, outcome: a.outcome, nextAction: a.next_action, nextActionDue: a.next_action_due,
    author: a.author_name, authorId: a.author_id, createdAt: a.created_at, editedAt: a.edited_at,
  });
  const ACT_SELECT = `SELECT a.id, a.type_id, a.type_name, a.description, a.outcome, a.next_action, a.next_action_due::text AS next_action_due, a.author_id, a.author_name, a.created_at, a.edited_at FROM integration_activities a`;

  app.get('/api/integrations/:id/activities', async (req) => {
    requirePermission(req, 'integrations.view');
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ order: z.enum(['asc', 'desc']).default('desc'), typeId: z.string().uuid().optional() }).merge(pageQuery), req.query);
    if (!(await queryOne(`SELECT 1 FROM customer_integrations WHERE id = $1`, [id]))) throw notFound('Integração não encontrada.');
    const values: unknown[] = [id];
    let extra = '';
    if (q.typeId) {
      values.push(q.typeId);
      extra = ` AND a.type_id = $2`;
    }
    const dir = q.order === 'asc' ? 'ASC' : 'DESC';
    const total = await queryOne<{ n: string }>(`SELECT count(*) AS n FROM integration_activities a WHERE a.integration_id = $1 AND a.deleted_at IS NULL${extra}`, values);
    const rows = await query(`${ACT_SELECT} WHERE a.integration_id = $1 AND a.deleted_at IS NULL${extra} ORDER BY a.created_at ${dir}, a.id ${dir} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, q.pageSize, (q.page - 1) * q.pageSize]);
    return { total: Number(total?.n ?? 0), items: rows.map(serializeActivity) };
  });

  const activitySchema = z.object({
    typeId: z.string().uuid('Selecione o tipo de atividade.'),
    description: text(10000, 'a descrição da atividade'),
    outcome: optText(10000),
    nextAction: optText(2000),
    nextActionDue: dateStr,
  });

  app.post('/api/integrations/:id/activities', async (req, reply) => {
    const user = requirePermission(req, 'integrations.log');
    const { id } = parse(idParam, req.params);
    const body = parse(activitySchema, req.body);
    const created = await withTransaction(async (client) => {
      const card = await fetchRow(id, client, true);
      if (!card) throw notFound('Integração não encontrada.');
      if (card.archived_at) throw conflict('ARCHIVED', 'Integração arquivada: restaure-a antes de registrar atividades.');
      const type = (await client.query(`SELECT id, name FROM integration_activity_types WHERE id = $1 AND active`, [body.typeId])).rows[0];
      if (!type) throw validationError('Tipo de atividade inválido.', { fields: { typeId: 'Tipo de atividade inválido.' } });
      // autor e data/hora vêm da sessão autenticada e do banco, nunca do cliente
      const r = await client.query(
        `INSERT INTO integration_activities (integration_id, type_id, type_name, description, outcome, next_action, next_action_due, author_id, author_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [id, type.id, type.name, body.description, body.outcome ?? null, body.nextAction ?? null, body.nextActionDue ?? null, user.id, user.name],
      );
      await client.query(`UPDATE customer_integrations SET updated_at = now() WHERE id = $1`, [id]);
      await audit({ actorId: user.id, action: 'integration.activity_create', entityType: 'customer_integration', entityId: id, data: { activityId: r.rows[0].id, type: type.name }, ip: req.ip }, client);
      return r.rows[0].id as string;
    });
    reply.code(201);
    
    return { activity: serializeActivity((await getPool().query(`${ACT_SELECT} WHERE a.id = $1`, [created])).rows[0]) };
  });

  app.put('/api/integrations/:id/activities/:activityId', async (req) => {
    const user = requirePermission(req, 'integrations.admin');
    const { id, activityId } = parse(z.object({ id: uuid, activityId: uuid }), req.params);
    const body = parse(activitySchema, req.body);
    await withTransaction(async (client) => {
      await fetchRow(id, client, true);
      const before = (await client.query(`${ACT_SELECT} WHERE a.id = $1 AND a.integration_id = $2 AND a.deleted_at IS NULL FOR UPDATE OF a`, [activityId, id])).rows[0] as Row | undefined;
      if (!before) throw notFound('Atividade não encontrada.');
      const type = (await client.query(`SELECT id, name FROM integration_activity_types WHERE id = $1`, [body.typeId])).rows[0];
      if (!type) throw validationError('Tipo de atividade inválido.');
      const next = { type_name: type.name, description: body.description, outcome: body.outcome ?? null, next_action: body.nextAction ?? null, next_action_due: body.nextActionDue ?? null } as Record<string, string | null>;
      const diffs = (['type_name', 'description', 'outcome', 'next_action', 'next_action_due'] as const).filter((k) => s(before[k]) !== next[k]);
      if (!diffs.length) return;
      await client.query(`UPDATE integration_activities SET type_id = $2, type_name = $3, description = $4, outcome = $5, next_action = $6, next_action_due = $7, edited_at = now() WHERE id = $1`, [activityId, type.id, next.type_name, next.description, next.outcome, next.next_action, next.next_action_due]);
      await client.query(`UPDATE customer_integrations SET updated_at = now() WHERE id = $1`, [id]);
      await writeChanges(client, id, randomUUID(), user, diffs.map((k) => ({ field: `activity.${k}`, old: s(before[k]), neu: next[k] ?? null, type: 'activity_edit' })));
      await audit({ actorId: user.id, action: 'integration.activity_update', entityType: 'customer_integration', entityId: id, data: { activityId, fields: diffs }, ip: req.ip }, client);
    });
    
    return { activity: serializeActivity((await getPool().query(`${ACT_SELECT} WHERE a.id = $1`, [activityId])).rows[0]) };
  });

  app.delete('/api/integrations/:id/activities/:activityId', async (req) => {
    const user = requirePermission(req, 'integrations.admin');
    const { id, activityId } = parse(z.object({ id: uuid, activityId: uuid }), req.params);
    await withTransaction(async (client) => {
      const a = (await client.query(`${ACT_SELECT} WHERE a.id = $1 AND a.integration_id = $2 AND a.deleted_at IS NULL FOR UPDATE OF a`, [activityId, id])).rows[0] as Row | undefined;
      if (!a) throw notFound('Atividade não encontrada.');
      await client.query(`UPDATE integration_activities SET deleted_at = now(), deleted_by = $2 WHERE id = $1`, [activityId, user.id]);
      await client.query(`UPDATE customer_integrations SET updated_at = now() WHERE id = $1`, [id]);
      await writeChanges(client, id, randomUUID(), user, [{ field: 'activity', old: `${a.type_name} (${a.author_name}, ${new Date(a.created_at as Date).toISOString()}): ${String(a.description).slice(0, 500)}`, neu: null, type: 'activity_delete' }]);
      await audit({ actorId: user.id, action: 'integration.activity_delete', entityType: 'customer_integration', entityId: id, data: { activityId }, ip: req.ip }, client);
    });
    return { ok: true };
  });

  // ---- Histórico de alterações cadastrais -----------------------------------------------------
  app.get('/api/integrations/:id/changes', async (req) => {
    requirePermission(req, 'integrations.history');
    const { id } = parse(idParam, req.params);
    if (!(await queryOne(`SELECT 1 FROM customer_integrations WHERE id = $1`, [id]))) throw notFound('Integração não encontrada.');
    const q = parse(
      z.object({ field: z.string().max(100).optional(), user: z.string().max(200).optional(), type: z.string().max(40).optional(), from: z.string().optional(), to: z.string().optional() }).merge(pageQuery),
      req.query,
    );
    const values: unknown[] = [id];
    const where = ['integration_id = $1'];
    const add = (sql: string, v: unknown) => {
      values.push(v);
      where.push(sql.replace('?', `$${values.length}`));
    };
    if (q.field) add('field_name = ?', q.field);
    if (q.user) add('user_name = ?', q.user);
    if (q.type) add('operation_type = ?', q.type);
    const range = dateRange(q.from, q.to);
    if (range.from) add('created_at >= ?', range.from);
    if (range.to) add('created_at <= ?', range.to);
    const w = where.join(' AND ');
    const total = await queryOne<{ n: string }>(`SELECT count(*) AS n FROM integration_changes WHERE ${w}`, values);
    const rows = await query(`SELECT * FROM integration_changes WHERE ${w} ORDER BY created_at DESC, id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, q.pageSize, (q.page - 1) * q.pageSize]);
    const [fields, users] = await Promise.all([
      query<{ field_name: string }>(`SELECT DISTINCT field_name FROM integration_changes WHERE integration_id = $1 ORDER BY field_name`, [id]),
      query<{ user_name: string }>(`SELECT DISTINCT user_name FROM integration_changes WHERE integration_id = $1 ORDER BY user_name`, [id]),
    ]);
    return {
      total: Number(total?.n ?? 0),
      items: rows.map((c) => ({ id: c.id, operationId: c.operation_id, type: c.operation_type, userId: c.user_id, user: c.user_name, field: c.field_name, fieldLabel: FIELD_LABELS[c.field_name as string] ?? c.field_name, from: c.old_value, to: c.new_value, at: c.created_at })),
      facets: { fields: fields.map((f) => ({ key: f.field_name, label: FIELD_LABELS[f.field_name] ?? f.field_name })), users: users.map((u) => u.user_name) },
    };
  });
}
