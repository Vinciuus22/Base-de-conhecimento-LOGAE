import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useBlocker, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Archive, ArrowLeft, CalendarClock, CheckCircle2, History, LayoutGrid, List, Pencil, Plus, RotateCcw, Save, Handshake, X } from 'lucide-react';
import { ApiError, errorMessage, fieldErrors, get, post, put, del, qs } from '../../lib/api';
import { formatDate, formatDateTime } from '../../lib/format';
import { useAuth } from '../../context/AuthContext';
import { PageHeader } from '../../components/Layout';
import { Alert, Button, ConfirmDialog, Empty, Field, Modal, Pagination, Spinner, useToast } from '../../components/ui';

// ---------------------------------------------------------------------------
// Tipos e utilidades
// ---------------------------------------------------------------------------
type Status = 'inicio' | 'acompanhamento' | 'finalizado';
const STATUS_META: Record<Status, { label: string; cls: string }> = {
  inicio: { label: 'Início', cls: 'badge-info' },
  acompanhamento: { label: 'Acompanhamento', cls: 'badge-warning' },
  finalizado: { label: 'Finalizado', cls: 'badge-success' },
};
const OP_LABEL: Record<string, string> = {
  create: 'Criação', update: 'Alteração', status_change: 'Mudança de status', finish: 'Finalização', reopen: 'Reabertura',
  archive: 'Arquivamento', restore: 'Restauração', activity_edit: 'Atividade corrigida', activity_delete: 'Atividade removida',
};

interface Ref { id: string; name: string }
interface Integration {
  id: string;
  company: Ref;
  system: Ref;
  objective: string;
  csGc: Ref;
  operator: Ref | null;
  status: Status;
  startedOn: string | null;
  expectedEndOn: string | null;
  finishedOn: string | null;
  nextAction: string | null;
  nextActionOwner: Ref | null;
  nextActionDue: string | null;
  overdue: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
  description?: string;
  nextActionNotes?: string | null;
  notes?: string | null;
  resultSummary?: string | null;
  finalNotes?: string | null;
  remainingPending?: string | null;
  finishedBy?: Ref | null;
  createdBy?: Ref;
}
interface Lookups { companies: Ref[]; systems: Ref[]; users: Ref[]; activityTypes: Ref[] }
interface Activity { id: string; typeId: string; type: string; description: string; outcome: string | null; nextAction: string | null; nextActionDue: string | null; author: string; createdAt: string; editedAt: string | null }
interface Change { id: string; operationId: string; type: string; user: string; field: string; fieldLabel: string; from: string | null; to: string | null; at: string }

const dateOnly = (v: string | null | undefined) => (v ? formatDate(`${v}T12:00:00`) : '—');

const STATUS_COLOR: Record<Status, string> = { inicio: '#0a4c8a', acompanhamento: '#d89a12', finalizado: '#19b987' };

function StatusBadge({ status }: { status: Status }) {
  const m = STATUS_META[status];
  return <span className={`badge ${m.cls}`}>{m.label}</span>;
}

/** Texto simples com parágrafos e listas ("- item"); nunca interpreta HTML. */
function FormattedText({ text }: { text: string | null | undefined }) {
  if (!text) return <span className="muted">—</span>;
  const blocks = text.split(/\n{2,}/);
  return (
    <>
      {blocks.map((b, i) => {
        const lines = b.split('\n');
        const isList = lines.every((l) => /^\s*[-*•]\s+/.test(l));
        return isList ? (
          <ul key={i}>{lines.map((l, j) => <li key={j}>{l.replace(/^\s*[-*•]\s+/, '')}</li>)}</ul>
        ) : (
          <p key={i} style={{ whiteSpace: 'pre-wrap', margin: '0 0 8px' }}>{b}</p>
        );
      })}
    </>
  );
}

function useLookups() {
  return useQuery({ queryKey: ['integration-lookups'], queryFn: () => get<Lookups>('/api/integrations/lookups'), staleTime: 30_000 });
}

// ---------------------------------------------------------------------------
// Listagem
// ---------------------------------------------------------------------------
interface ListResp { total: number; items: Integration[]; stats: { total: number; inicio: number; acompanhamento: number; finalizado: number; overdue: number } }

export function IntegrationsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<'cards' | 'table'>(() => {
    try { return localStorage.getItem('integrations-view') === 'table' ? 'table' : 'cards'; } catch { return 'cards'; }
  });
  const g = (k: string) => params.get(k) ?? '';
  const page = Number(params.get('page') ?? 1) || 1;
  const filters = { q: g('q'), status: g('status'), companyId: g('companyId'), systemId: g('systemId'), csGcId: g('csGcId'), operatorId: g('operatorId'), createdFrom: g('createdFrom'), createdTo: g('createdTo'), expectedFrom: g('expectedFrom'), expectedTo: g('expectedTo'), updatedFrom: g('updatedFrom'), updatedTo: g('updatedTo'), overdue: g('overdue'), archived: g('archived'), sort: g('sort') || 'updated', dir: g('dir') || 'desc' };
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    next.delete('page');
    setParams(next, { replace: true });
  };
  const lookups = useLookups();
  const list = useQuery({ queryKey: ['integrations', filters, page], queryFn: () => get<ListResp>(`/api/integrations${qs({ ...filters, page, pageSize: 18 })}`), placeholderData: (p) => p });
  const L = lookups.data;
  const stats = list.data?.stats;
  const hasFilters = Object.entries(filters).some(([k, v]) => v && !(k === 'sort' && v === 'updated') && !(k === 'dir' && v === 'desc'));
  const back = params.toString();
  const detailTo = (id: string) => `/interno/integracoes/${id}${back ? `?voltar=${encodeURIComponent(back)}` : ''}`;
  const tile = (label: string, value: number | undefined, patch: Record<string, string>, active: boolean, accent: string) => (
    <button type="button" className="stat-card" style={{ ['--accent' as string]: accent }} aria-pressed={active} onClick={() => set(active ? { status: '', overdue: '' } : { status: '', overdue: '', ...patch })}>
      <strong>{value ?? '—'}</strong>
      <span>{label}</span>
    </button>
  );
  const sel = (id: string, label: string, key: string, options: Ref[] | undefined) => (
    <Field label={label} htmlFor={id}>
      <select id={id} className="select" value={g(key)} onChange={(e) => set({ [key]: e.target.value })}>
        <option value="">Todos</option>
        {options?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </Field>
  );

  return (
    <div className="page">
      <PageHeader
        title="Integração de Clientes"
        subtitle="Acompanhamento dos processos de integração: reuniões, atividades, pendências e resultados."
        actions={can('integrations.create') ? <Link className="btn btn-cta" to="/interno/integracoes/nova"><Plus size={16} aria-hidden /> Nova integração</Link> : undefined}
      />
      <div className="stat-grid" data-testid="integration-stats">
        {tile('Total de integrações', stats?.total, {}, false, '#064b3a')}
        {tile('Em início', stats?.inicio, { status: 'inicio' }, filters.status === 'inicio', '#0a4c8a')}
        {tile('Em acompanhamento', stats?.acompanhamento, { status: 'acompanhamento' }, filters.status === 'acompanhamento', '#8a5a00')}
        {tile('Finalizadas', stats?.finalizado, { status: 'finalizado' }, filters.status === 'finalizado', '#19b987')}
        {tile('Próxima ação vencida', stats?.overdue, { overdue: '1' }, filters.overdue === '1', '#b3261e')}
      </div>
      <div className="card card-body" style={{ marginBottom: 16 }}>
        <div className="grid grid-4">
          <Field label="Pesquisar" htmlFor="ig-q"><input id="ig-q" className="input" placeholder="Empresa, TMS, objetivo, CS/GC ou responsável" value={filters.q} onChange={(e) => set({ q: e.target.value })} /></Field>
          <Field label="Status" htmlFor="ig-st">
            <select id="ig-st" className="select" value={filters.status} onChange={(e) => set({ status: e.target.value })}>
              <option value="">Todos</option>
              {(Object.keys(STATUS_META) as Status[]).map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
            </select>
          </Field>
          {sel('ig-co', 'Empresa', 'companyId', L?.companies)}
          {sel('ig-sy', 'TMS', 'systemId', L?.systems)}
          {sel('ig-cs', 'CS/GC', 'csGcId', L?.users)}
          {sel('ig-op', 'Responsável operacional', 'operatorId', L?.users)}
        </div>
        <details style={{ marginTop: 12 }} open={!!(filters.createdFrom || filters.createdTo || filters.expectedFrom || filters.expectedTo || filters.updatedFrom || filters.updatedTo)}>
          <summary className="small" style={{ cursor: 'pointer' }}>Filtros de data</summary>
          <div className="grid grid-4" style={{ marginTop: 8 }}>
          <Field label="Criado a partir de" htmlFor="ig-cf"><input id="ig-cf" type="date" className="input" value={filters.createdFrom} onChange={(e) => set({ createdFrom: e.target.value })} /></Field>
          <Field label="Criado até" htmlFor="ig-ct"><input id="ig-ct" type="date" className="input" value={filters.createdTo} onChange={(e) => set({ createdTo: e.target.value })} /></Field>
          <Field label="Conclusão prevista a partir de" htmlFor="ig-ef"><input id="ig-ef" type="date" className="input" value={filters.expectedFrom} onChange={(e) => set({ expectedFrom: e.target.value })} /></Field>
          <Field label="Conclusão prevista até" htmlFor="ig-et"><input id="ig-et" type="date" className="input" value={filters.expectedTo} onChange={(e) => set({ expectedTo: e.target.value })} /></Field>
          <Field label="Atualizado a partir de" htmlFor="ig-uf"><input id="ig-uf" type="date" className="input" value={filters.updatedFrom} onChange={(e) => set({ updatedFrom: e.target.value })} /></Field>
          <Field label="Atualizado até" htmlFor="ig-ut"><input id="ig-ut" type="date" className="input" value={filters.updatedTo} onChange={(e) => set({ updatedTo: e.target.value })} /></Field>
          </div>
        </details>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap', marginTop: 12, justifyContent: 'space-between' }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <label className="row" style={{ gap: 6 }}>
              Ordenar por
              <select className="select" aria-label="Ordenar por" value={filters.sort} onChange={(e) => set({ sort: e.target.value === 'updated' ? '' : e.target.value })}>
                <option value="updated">Última atualização</option>
                <option value="created">Data de criação</option>
                <option value="company">Empresa</option>
                <option value="status">Status</option>
                <option value="expected">Data prevista para conclusão</option>
              </select>
            </label>
            <Button size="sm" onClick={() => set({ dir: filters.dir === 'desc' ? 'asc' : '' })}>{filters.dir === 'desc' ? 'Decrescente' : 'Crescente'}</Button>
            {can('integrations.archive') && <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={filters.archived === '1'} onChange={(e) => set({ archived: e.target.checked ? '1' : '' })} /> Arquivadas</label>}
            {hasFilters && <Button size="sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>Limpar filtros</Button>}
          </div>
          <div className="btn-group" role="group" aria-label="Modo de visualização">
            <Button size="sm" aria-pressed={view === 'cards'} onClick={() => { setView('cards'); try { localStorage.setItem('integrations-view', 'cards'); } catch { /* opcional */ } }}><LayoutGrid size={14} aria-hidden /> Cards</Button>
            <Button size="sm" aria-pressed={view === 'table'} onClick={() => { setView('table'); try { localStorage.setItem('integrations-view', 'table'); } catch { /* opcional */ } }}><List size={14} aria-hidden /> Tabela</Button>
          </div>
        </div>
      </div>

      {list.isLoading ? <Spinner /> : list.isError ? <Alert kind="danger">{errorMessage(list.error)}</Alert> : !list.data?.items.length ? (
        <div className="card"><Empty title={hasFilters ? 'Nenhuma integração encontrada com os filtros aplicados.' : 'Nenhuma integração cadastrada.'} /></div>
      ) : view === 'cards' ? (
        <div className="grid grid-3" data-testid="integration-cards">
          {list.data.items.map((i) => (
            <article key={i.id} className="card card-body integration-card" data-testid="integration-card" style={{ ['--status-color' as string]: STATUS_COLOR[i.status] }}>
              <div className="row" style={{ justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                <h3 style={{ margin: 0, fontSize: 17 }}><Link to={detailTo(i.id)}>{i.company.name}</Link></h3>
                <StatusBadge status={i.status} />
              </div>
              <div className="small"><strong>TMS:</strong> {i.system.name}</div>
              <div className="small" style={{ overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}>{i.objective}</div>
              <dl className="integration-meta">
                <div><dt>CS/GC</dt><dd>{i.csGc.name}</dd></div>
                <div><dt>Responsável</dt><dd>{i.operator?.name ?? <span className="muted">Não definido</span>}</dd></div>
                <div><dt>Criada em</dt><dd>{formatDate(i.createdAt)}</dd></div>
                <div><dt>Atualizada em</dt><dd>{formatDateTime(i.updatedAt)}</dd></div>
              </dl>
              {i.nextAction ? (
                <div className={`next-action ${i.overdue ? 'next-action-overdue' : ''}`}>
                  <strong className="small">{i.overdue ? 'Próxima ação vencida' : 'Próxima ação'}</strong>
                  <div className="small">{i.nextAction}{i.nextActionDue && <> · {dateOnly(i.nextActionDue)}</>}</div>
                </div>
              ) : (
                <div className="tiny muted">Próxima ação não cadastrada</div>
              )}
            </article>
          ))}
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table" data-testid="integration-table">
            <thead><tr><th>Empresa</th><th>TMS</th><th>Objetivo</th><th>CS/GC</th><th>Operacional</th><th>Status</th><th>Próxima ação</th><th>Criado</th><th>Atualizado</th></tr></thead>
            <tbody>
              {list.data.items.map((i) => (
                <tr key={i.id}>
                  <td><Link to={detailTo(i.id)}><strong>{i.company.name}</strong></Link></td>
                  <td>{i.system.name}</td>
                  <td>{i.objective.length > 90 ? `${i.objective.slice(0, 90)}…` : i.objective}</td>
                  <td>{i.csGc.name}</td>
                  <td>{i.operator?.name ?? '—'}</td>
                  <td><StatusBadge status={i.status} /></td>
                  <td>{i.nextAction ?? '—'}{i.nextActionDue && <div className={`tiny ${i.overdue ? 'text-danger' : 'muted'}`}>{dateOnly(i.nextActionDue)}{i.overdue && ' · vencida'}</div>}</td>
                  <td>{formatDate(i.createdAt)}</td>
                  <td>{formatDateTime(i.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data && <Pagination page={page} pageSize={18} total={list.data.total} onChange={(p) => { const n = new URLSearchParams(params); n.set('page', String(p)); setParams(n, { replace: true }); }} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formulário (criação e edição)
// ---------------------------------------------------------------------------
interface FormState {
  companyId: string; systemId: string; objective: string; csGcId: string; operatorId: string; description: string; status: Status;
  startedOn: string; expectedEndOn: string; finishedOn: string; nextAction: string; nextActionOwnerId: string; nextActionDue: string; nextActionNotes: string; notes: string;
}
const emptyForm: FormState = { companyId: '', systemId: '', objective: '', csGcId: '', operatorId: '', description: '', status: 'inicio', startedOn: '', expectedEndOn: '', finishedOn: '', nextAction: '', nextActionOwnerId: '', nextActionDue: '', nextActionNotes: '', notes: '' };
const toForm = (i: Integration): FormState => ({
  companyId: i.company.id, systemId: i.system.id, objective: i.objective, csGcId: i.csGc.id, operatorId: i.operator?.id ?? '', description: i.description ?? '', status: i.status,
  startedOn: i.startedOn ?? '', expectedEndOn: i.expectedEndOn ?? '', finishedOn: i.finishedOn ?? '', nextAction: i.nextAction ?? '', nextActionOwnerId: i.nextActionOwner?.id ?? '',
  nextActionDue: i.nextActionDue ?? '', nextActionNotes: i.nextActionNotes ?? '', notes: i.notes ?? '',
});

function QuickCreate({ kind, onDone, onClose }: { kind: 'company' | 'system'; onDone: (r: Ref) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (kind === 'company') onDone((await post<{ company: Ref }>('/api/companies', { name })).company);
      else onDone((await post<{ system: Ref }>('/api/systems', { name })).system);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={kind === 'company' ? 'Nova empresa' : 'Novo TMS'} onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} disabled={name.trim().length < 2} onClick={submit}>Cadastrar</Button></>}>
      <Field label="Nome" htmlFor="qc-name" required error={err ?? undefined}><input id="qc-name" className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
    </Modal>
  );
}

function IntegrationFields({ form, onChange, errors, mode, lookups, canFinishDate }: { form: FormState; onChange: (p: Partial<FormState>) => void; errors: Record<string, string>; mode: 'create' | 'edit'; lookups?: Lookups; canFinishDate?: boolean }) {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [quick, setQuick] = useState<null | 'company' | 'system'>(null);
  const L = lookups;
  const users = (id: string, label: string, key: keyof FormState, required = false, err?: string) => (
    <Field label={label} htmlFor={id} required={required} error={err}>
      <select id={id} className="select" value={form[key]} onChange={(e) => onChange({ [key]: e.target.value })}>
        <option value="">{required ? 'Selecione…' : '—'}</option>
        {L?.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select>
    </Field>
  );
  const afterQuick = (kind: 'company' | 'system') => (r: Ref) => {
    void queryClient.invalidateQueries({ queryKey: ['integration-lookups'] });
    onChange(kind === 'company' ? { companyId: r.id } : { systemId: r.id });
    setQuick(null);
  };
  return (
    <div className="stack">
      <div className="grid grid-2">
        <Field label="Empresa" htmlFor="if-co" required error={errors.companyId}>
          <div className="row" style={{ gap: 6 }}>
            <select id="if-co" className="select" style={{ flex: 1 }} value={form.companyId} onChange={(e) => onChange({ companyId: e.target.value })}>
              <option value="">Selecione…</option>
              {L?.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {can('users.manage') && <Button size="sm" aria-label="Cadastrar nova empresa" onClick={() => setQuick('company')}><Plus size={14} aria-hidden /></Button>}
          </div>
        </Field>
        <Field label="TMS" htmlFor="if-sy" required error={errors.systemId}>
          <div className="row" style={{ gap: 6 }}>
            <select id="if-sy" className="select" style={{ flex: 1 }} value={form.systemId} onChange={(e) => onChange({ systemId: e.target.value })}>
              <option value="">Selecione…</option>
              {L?.systems.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {can('categories.manage') && <Button size="sm" aria-label="Cadastrar novo TMS" onClick={() => setQuick('system')}><Plus size={14} aria-hidden /></Button>}
          </div>
        </Field>
        {users('if-cs', 'CS/GC da conta', 'csGcId', true, errors.csGcId)}
        {users('if-op', 'Responsável operacional', 'operatorId', false, errors.operatorId)}
      </div>
      <Field label="Objetivo" htmlFor="if-obj" required error={errors.objective} hint="Finalidade da integração e resultado esperado para o cliente.">
        <textarea id="if-obj" className="textarea" rows={3} value={form.objective} onChange={(e) => onChange({ objective: e.target.value })} />
      </Field>
      <Field label="Descrição" htmlFor="if-desc" required error={errors.description} hint="Contexto inicial do processo. Use linhas em branco para parágrafos e “- ” para listas.">
        <textarea id="if-desc" className="textarea" rows={7} value={form.description} onChange={(e) => onChange({ description: e.target.value })} />
      </Field>
      <div className="grid grid-4">
        <Field label="Status" htmlFor="if-st" required error={errors.status}>
          {mode === 'create' || form.status !== 'finalizado' ? (
            <select id="if-st" className="select" value={form.status} onChange={(e) => onChange({ status: e.target.value as Status })}>
              <option value="inicio">Início</option>
              <option value="acompanhamento">Acompanhamento</option>
            </select>
          ) : <input id="if-st" className="input" disabled value="Finalizado (use Reabrir para alterar)" />}
        </Field>
        <Field label="Data de início" htmlFor="if-sd" error={errors.startedOn}><input id="if-sd" type="date" className="input" value={form.startedOn} onChange={(e) => onChange({ startedOn: e.target.value })} /></Field>
        <Field label="Previsão de conclusão" htmlFor="if-ed" error={errors.expectedEndOn}><input id="if-ed" type="date" className="input" value={form.expectedEndOn} onChange={(e) => onChange({ expectedEndOn: e.target.value })} /></Field>
        {mode === 'edit' && form.status === 'finalizado' && <Field label="Data de finalização" htmlFor="if-fd" error={errors.finishedOn}><input id="if-fd" type="date" className="input" disabled={!canFinishDate} value={form.finishedOn} onChange={(e) => onChange({ finishedOn: e.target.value })} /></Field>}
      </div>
      <fieldset className="card card-body" style={{ margin: 0 }}>
        <legend className="label">Próxima ação</legend>
        <div className="grid grid-2">
          <Field label="Descrição da ação" htmlFor="if-na" error={errors.nextAction}><input id="if-na" className="input" value={form.nextAction} onChange={(e) => onChange({ nextAction: e.target.value })} /></Field>
          {users('if-nao', 'Responsável pela ação', 'nextActionOwnerId', false, errors.nextActionOwnerId)}
          <Field label="Data prevista" htmlFor="if-nad" error={errors.nextActionDue}><input id="if-nad" type="date" className="input" value={form.nextActionDue} onChange={(e) => onChange({ nextActionDue: e.target.value })} /></Field>
          <Field label="Observações da ação" htmlFor="if-nan" error={errors.nextActionNotes}><input id="if-nan" className="input" value={form.nextActionNotes} onChange={(e) => onChange({ nextActionNotes: e.target.value })} /></Field>
        </div>
      </fieldset>
      <Field label="Observações gerais" htmlFor="if-notes" error={errors.notes}><textarea id="if-notes" className="textarea" rows={3} value={form.notes} onChange={(e) => onChange({ notes: e.target.value })} /></Field>
      {quick && <QuickCreate kind={quick} onClose={() => setQuick(null)} onDone={afterQuick(quick)} />}
    </div>
  );
}

const nullIfEmpty = (v: string) => (v.trim() === '' ? null : v);
const toBody = (f: FormState) => ({
  companyId: f.companyId, systemId: f.systemId, objective: f.objective, csGcId: f.csGcId, operatorId: nullIfEmpty(f.operatorId), description: f.description, status: f.status,
  startedOn: nullIfEmpty(f.startedOn), expectedEndOn: nullIfEmpty(f.expectedEndOn), nextAction: nullIfEmpty(f.nextAction), nextActionOwnerId: nullIfEmpty(f.nextActionOwnerId),
  nextActionDue: nullIfEmpty(f.nextActionDue), nextActionNotes: nullIfEmpty(f.nextActionNotes), notes: nullIfEmpty(f.notes),
});

function clientValidate(f: FormState): Record<string, string> {
  const e: Record<string, string> = {};
  if (!f.companyId) e.companyId = 'Selecione a empresa.';
  if (!f.systemId) e.systemId = 'Selecione o TMS.';
  if (!f.csGcId) e.csGcId = 'Selecione o CS/GC da conta.';
  if (!f.objective.trim()) e.objective = 'Informe o objetivo.';
  if (!f.description.trim()) e.description = 'Informe a descrição.';
  if (f.startedOn && f.expectedEndOn && f.expectedEndOn < f.startedOn) e.expectedEndOn = 'A previsão não pode ser anterior ao início.';
  return e;
}

export function IntegrationNewPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const lookups = useLookups();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestId = useRef(crypto.randomUUID()); // reenvio do mesmo formulário não duplica o card
  const dirty = JSON.stringify(form) !== JSON.stringify(emptyForm);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && !busy && currentLocation.pathname !== nextLocation.pathname);

  const submit = async () => {
    const e = clientValidate(form);
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ integration: Integration }>('/api/integrations', { ...toBody(form), requestId: requestId.current });
      await queryClient.invalidateQueries({ queryKey: ['integrations'] });
      toast('success', 'Integração cadastrada.');
      navigate(`/interno/integracoes/${res.integration.id}`, { replace: true });
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <div className="page" style={{ maxWidth: 1000 }}>
      <PageHeader title="Nova integração" icon={<Handshake size={24} aria-hidden />} actions={<Link className="btn" to="/interno/integracoes"><ArrowLeft size={16} aria-hidden /> Voltar</Link>} />
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
        <IntegrationFields form={form} onChange={(p) => setForm((f) => ({ ...f, ...p }))} errors={errors} mode="create" lookups={lookups.data} />
        {error && <div style={{ marginTop: 12 }}><Alert kind="danger">{error}</Alert></div>}
        <div className="btn-group" style={{ marginTop: 16 }}>
          <Button type="submit" variant="primary" loading={busy}><Save size={16} aria-hidden /> Cadastrar integração</Button>
          <Link className="btn" to="/interno/integracoes">Cancelar</Link>
        </div>
      </form>
      {blocker.state === 'blocked' && <ConfirmDialog title="Descartar o cadastro?" message="Há dados não salvos. Se sair agora, eles serão perdidos." confirmLabel="Descartar" danger onConfirm={() => blocker.proceed()} onCancel={() => blocker.reset()} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detalhe
// ---------------------------------------------------------------------------
function Compare({ from, to }: { from: string | null; to: string | null }) {
  const [open, setOpen] = useState(false);
  const long = (from?.length ?? 0) > 120 || (to?.length ?? 0) > 120 || (from ?? '').includes('\n') || (to ?? '').includes('\n');
  const val = (v: string | null) => (v === null ? <em className="muted">(vazio)</em> : <span style={{ whiteSpace: 'pre-wrap' }}>{open || !long ? v : `${v.slice(0, 120)}…`}</span>);
  return (
    <div className="grid grid-2" style={{ gap: 8 }}>
      <div><span className="tiny muted">Anterior</span><div className="small">{val(from)}</div></div>
      <div><span className="tiny muted">Novo</span><div className="small">{val(to)}</div></div>
      {long && <button type="button" className="btn btn-sm btn-ghost" aria-expanded={open} onClick={() => setOpen(!open)} style={{ gridColumn: '1 / -1', justifySelf: 'start' }}>{open ? 'Recolher' : 'Expandir e comparar'}</button>}
    </div>
  );
}

function ChangesSection({ id }: { id: string }) {
  const [f, setF] = useState({ field: '', user: '', type: '' });
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['integration-changes', id, f, page], queryFn: () => get<{ total: number; items: Change[]; facets: { fields: Array<{ key: string; label: string }>; users: string[] } }>(`/api/integrations/${id}/changes${qs({ ...f, page, pageSize: 20 })}`), placeholderData: (p) => p });
  const set = (k: keyof typeof f, v: string) => { setF((x) => ({ ...x, [k]: v })); setPage(1); };
  return (
    <section aria-labelledby="ch-title" className="stack">
      <h2 id="ch-title" className="row" style={{ gap: 8 }}><History size={20} aria-hidden /> Histórico de alterações {q.data && <span className="muted small">({q.data.total})</span>}</h2>
      <div className="grid grid-3">
        <Field label="Campo" htmlFor="ch-f"><select id="ch-f" className="select" value={f.field} onChange={(e) => set('field', e.target.value)}><option value="">Todos</option>{q.data?.facets.fields.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></Field>
        <Field label="Usuário" htmlFor="ch-u"><select id="ch-u" className="select" value={f.user} onChange={(e) => set('user', e.target.value)}><option value="">Todos</option>{q.data?.facets.users.map((x) => <option key={x} value={x}>{x}</option>)}</select></Field>
        <Field label="Operação" htmlFor="ch-t"><select id="ch-t" className="select" value={f.type} onChange={(e) => set('type', e.target.value)}><option value="">Todas</option>{Object.entries(OP_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      </div>
      {q.isLoading ? <Spinner /> : !q.data?.items.length ? <Empty title="Nenhuma alteração registrada." /> : (
        <div className="card table-wrap">
          <table className="table" data-testid="changes-table">
            <thead><tr><th>Data e hora</th><th>Usuário</th><th>Operação</th><th>Campo</th><th>Valores</th></tr></thead>
            <tbody>
              {q.data.items.map((c) => (
                <tr key={c.id} data-testid="change-row">
                  <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(c.at)}</td>
                  <td>{c.user}</td>
                  <td>{OP_LABEL[c.type] ?? c.type}</td>
                  <td>{c.fieldLabel}</td>
                  <td><Compare from={c.from} to={c.to} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.data && <Pagination page={page} pageSize={20} total={q.data.total} onChange={setPage} />}
    </section>
  );
}

function ActivityForm({ types, initial, onSubmit, onCancel, submitLabel }: { types: Ref[]; initial?: Activity; onSubmit: (b: Record<string, unknown>) => Promise<void>; onCancel?: () => void; submitLabel: string }) {
  const [s, setS] = useState({ typeId: initial?.typeId ?? '', description: initial?.description ?? '', outcome: initial?.outcome ?? '', nextAction: initial?.nextAction ?? '', nextActionDue: initial?.nextActionDue ?? '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const e: Record<string, string> = {};
    if (!s.typeId) e.typeId = 'Selecione o tipo.';
    if (!s.description.trim()) e.description = 'Descreva a atividade.';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ typeId: s.typeId, description: s.description, outcome: nullIfEmpty(s.outcome), nextAction: nullIfEmpty(s.nextAction), nextActionDue: nullIfEmpty(s.nextActionDue) });
      if (!initial) setS({ typeId: s.typeId, description: '', outcome: '', nextAction: '', nextActionDue: '' });
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate aria-label="Registrar atividade">
      <div className="grid grid-2">
        <Field label="Tipo de atividade" htmlFor="ac-type" required error={errors.typeId}><select id="ac-type" className="select" value={s.typeId} onChange={(e) => setS({ ...s, typeId: e.target.value })}><option value="">Selecione…</option>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
        <Field label="Data prevista da próxima ação" htmlFor="ac-due" error={errors.nextActionDue}><input id="ac-due" type="date" className="input" value={s.nextActionDue} onChange={(e) => setS({ ...s, nextActionDue: e.target.value })} /></Field>
      </div>
      <Field label="Descrição da atividade" htmlFor="ac-desc" required error={errors.description}><textarea id="ac-desc" className="textarea" rows={3} value={s.description} onChange={(e) => setS({ ...s, description: e.target.value })} /></Field>
      <div className="grid grid-2">
        <Field label="Resultado ou encaminhamento" htmlFor="ac-out"><textarea id="ac-out" className="textarea" rows={2} value={s.outcome} onChange={(e) => setS({ ...s, outcome: e.target.value })} /></Field>
        <Field label="Próxima ação" htmlFor="ac-next"><textarea id="ac-next" className="textarea" rows={2} value={s.nextAction} onChange={(e) => setS({ ...s, nextAction: e.target.value })} /></Field>
      </div>
      {error && <Alert kind="danger">{error}</Alert>}
      <div className="btn-group"><Button type="submit" variant="primary" loading={busy}><Plus size={16} aria-hidden /> {submitLabel}</Button>{onCancel && <Button onClick={onCancel}>Cancelar</Button>}</div>
    </form>
  );
}

function ActivitiesSection({ integration, lookups }: { integration: Integration; lookups?: Lookups }) {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [typeId, setTypeId] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Activity | null>(null);
  const [removing, setRemoving] = useState<Activity | null>(null);
  const key = ['integration-activities', integration.id, order, typeId, page];
  const q = useQuery({ queryKey: key, queryFn: () => get<{ total: number; items: Activity[] }>(`/api/integrations/${integration.id}/activities${qs({ order, typeId, page, pageSize: 20 })}`), placeholderData: (p) => p });
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['integration-activities', integration.id] });
    await queryClient.invalidateQueries({ queryKey: ['integration-changes', integration.id] });
    await queryClient.invalidateQueries({ queryKey: ['integration', integration.id] });
  };
  return (
    <section aria-labelledby="ac-title" className="stack">
      <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <h2 id="ac-title" style={{ margin: 0 }}>Histórico do acompanhamento {q.data && <span className="muted small">({q.data.total})</span>}</h2>
        <div className="row" style={{ gap: 8 }}>
          <select className="select" aria-label="Filtrar por tipo" value={typeId} onChange={(e) => { setTypeId(e.target.value); setPage(1); }}><option value="">Todos os tipos</option>{lookups?.activityTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <Button size="sm" onClick={() => setOrder(order === 'desc' ? 'asc' : 'desc')}>{order === 'desc' ? 'Mais recentes primeiro' : 'Mais antigas primeiro'}</Button>
        </div>
      </div>
      {can('integrations.log') && !integration.archived && (
        <div className="card card-body"><strong>Adicionar atividade</strong><ActivityForm types={lookups?.activityTypes ?? []} submitLabel="Registrar atividade" onSubmit={async (b) => { await post(`/api/integrations/${integration.id}/activities`, b); toast('success', 'Atividade registrada.'); await refresh(); }} /></div>
      )}
      {q.isLoading ? <Spinner /> : !q.data?.items.length ? <Empty title="Nenhuma atividade registrada." /> : (
        <ol style={{ listStyle: 'none', padding: 0, margin: 0 }} data-testid="activity-list">
          {q.data.items.map((a) => (
            <li key={a.id} className="card card-body" style={{ marginBottom: 8 }} data-testid="activity-item">
              <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <span><span className="badge badge-info">{a.type}</span> <time dateTime={a.createdAt} className="small muted">{formatDateTime(a.createdAt)}</time></span>
                {can('integrations.admin') && <span className="btn-group"><Button size="sm" onClick={() => setEditing(a)} aria-label="Corrigir atividade"><Pencil size={12} aria-hidden /></Button><Button size="sm" variant="danger" onClick={() => setRemoving(a)} aria-label="Remover atividade"><X size={12} aria-hidden /></Button></span>}
              </div>
              <div style={{ marginTop: 6 }}><FormattedText text={a.description} /></div>
              {a.outcome && <div className="small"><strong>Resultado/encaminhamento:</strong> {a.outcome}</div>}
              {a.nextAction && <div className="small"><strong>Próxima ação:</strong> {a.nextAction}{a.nextActionDue && <> · prevista para {dateOnly(a.nextActionDue)}</>}</div>}
              <div className="tiny muted" style={{ marginTop: 4 }}>Registrado por {a.author}{a.editedAt && ` · corrigido em ${formatDateTime(a.editedAt)}`}</div>
            </li>
          ))}
        </ol>
      )}
      {q.data && <Pagination page={page} pageSize={20} total={q.data.total} onChange={setPage} />}
      {editing && <Modal title="Corrigir atividade" wide onClose={() => setEditing(null)}><ActivityForm types={lookups?.activityTypes ?? []} initial={editing} submitLabel="Salvar correção" onCancel={() => setEditing(null)} onSubmit={async (b) => { await put(`/api/integrations/${integration.id}/activities/${editing.id}`, b); setEditing(null); toast('success', 'Atividade corrigida.'); await refresh(); }} /></Modal>}
      {removing && <ConfirmDialog title="Remover atividade?" danger confirmLabel="Remover" message="A atividade deixa de ser exibida; o conteúdo permanece no histórico de alterações." onCancel={() => setRemoving(null)} onConfirm={async () => { await del(`/api/integrations/${integration.id}/activities/${removing.id}`); setRemoving(null); toast('success', 'Atividade removida.'); await refresh(); }} />}
    </section>
  );
}

function FinishDialog({ integration, onClose, onDone }: { integration: Integration; onClose: () => void; onDone: () => Promise<void> }) {
  const [s, setS] = useState({ finishedOn: '', resultSummary: '', finalNotes: '', remainingPending: '', confirm: false });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    const e: Record<string, string> = {};
    if (!s.resultSummary.trim()) e.resultSummary = 'Informe o resumo do resultado.';
    if (!s.confirm) e.confirm = 'Confirme a finalização.';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setError(null);
    try {
      await post(`/api/integrations/${integration.id}/finish`, { version: integration.version, confirm: true, finishedOn: nullIfEmpty(s.finishedOn), resultSummary: s.resultSummary, finalNotes: nullIfEmpty(s.finalNotes), remainingPending: nullIfEmpty(s.remainingPending) });
      await onDone();
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Finalizar integração" wide onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} onClick={run}><CheckCircle2 size={16} aria-hidden /> Finalizar integração</Button></>}>
      <div className="stack">
        <Field label="Data de conclusão" htmlFor="fn-date" hint="Em branco = hoje."><input id="fn-date" type="date" className="input" value={s.finishedOn} onChange={(e) => setS({ ...s, finishedOn: e.target.value })} /></Field>
        <Field label="Resumo do resultado" htmlFor="fn-res" required error={errors.resultSummary}><textarea id="fn-res" className="textarea" rows={3} value={s.resultSummary} onChange={(e) => setS({ ...s, resultSummary: e.target.value })} /></Field>
        <Field label="Observações finais" htmlFor="fn-obs"><textarea id="fn-obs" className="textarea" rows={2} value={s.finalNotes} onChange={(e) => setS({ ...s, finalNotes: e.target.value })} /></Field>
        <Field label="Pendências remanescentes" htmlFor="fn-pen"><textarea id="fn-pen" className="textarea" rows={2} value={s.remainingPending} onChange={(e) => setS({ ...s, remainingPending: e.target.value })} /></Field>
        <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={s.confirm} onChange={(e) => setS({ ...s, confirm: e.target.checked })} /> Confirmo a finalização desta integração. O histórico será preservado.</label>
        {errors.confirm && <span className="error" role="alert">{errors.confirm}</span>}
        {error && <Alert kind="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}

function ReopenDialog({ integration, onClose, onDone }: { integration: Integration; onClose: () => void; onDone: () => Promise<void> }) {
  const [status, setStatus] = useState<'inicio' | 'acompanhamento'>('acompanhamento');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/integrations/${integration.id}/reopen`, { version: integration.version, reason, status });
      await onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Reabrir integração" onClose={onClose} footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} disabled={reason.trim().length < 5} onClick={run}><RotateCcw size={16} aria-hidden /> Reabrir</Button></>}>
      <div className="stack">
        <Field label="Reabrir como" htmlFor="ro-st"><select id="ro-st" className="select" value={status} onChange={(e) => setStatus(e.target.value as 'inicio' | 'acompanhamento')}><option value="inicio">Início</option><option value="acompanhamento">Acompanhamento</option></select></Field>
        <Field label="Motivo da reabertura" htmlFor="ro-reason" required><textarea id="ro-reason" className="textarea" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <p className="small muted">A finalização anterior (data e resultado) permanece registrada no histórico de alterações.</p>
        {error && <Alert kind="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}

export function IntegrationDetailPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const lookups = useLookups();
  const q = useQuery({ queryKey: ['integration', id], queryFn: () => get<{ integration: Integration }>(`/api/integrations/${id}`).then((r) => r.integration) });
  const [form, setForm] = useState<FormState | null>(null); // null = visualização
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<null | 'finish' | 'reopen' | 'archive' | 'restore' | 'discard'>(null);
  const i = q.data;
  const original = useMemo(() => (i ? toForm(i) : null), [i]);
  const dirty = !!form && !!original && JSON.stringify(form) !== JSON.stringify(original);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);

  const reload = async () => {
    await queryClient.invalidateQueries({ queryKey: ['integration', id] });
    await queryClient.invalidateQueries({ queryKey: ['integration-changes', id] });
    await queryClient.invalidateQueries({ queryKey: ['integrations'] });
  };
  const afterAction = (msg: string) => async () => { setDialog(null); toast('success', msg); await reload(); };

  if (q.isLoading) return <Spinner />;
  if (!i) return <div className="page page-narrow"><Empty title="Integração não encontrada."><Link to="/interno/integracoes" className="btn">Voltar</Link></Empty></div>;

  const save = async () => {
    if (!form) return;
    const e = clientValidate(form);
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { ...toBody(form), version: i.version };
      if (i.status === 'finalizado') {
        body.status = undefined;
        if (can('integrations.finish')) body.finishedOn = nullIfEmpty(form.finishedOn);
      }
      const res = await put<{ changed: boolean }>(`/api/integrations/${id}`, body);
      await reload();
      setForm(null);
      toast('success', res.changed ? 'Alterações salvas.' : 'Nenhuma alteração a salvar.');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') setConflict(true);
      setErrors(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const startEdit = () => { setForm(toForm(i)); setErrors({}); setError(null); setConflict(false); };
  const cancel = () => (dirty ? setDialog('discard') : setForm(null));
  const back = params.get('voltar');
  const editable = !i.archived && can('integrations.edit');

  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <Link to={`/interno/integracoes${back ? `?${back}` : ''}`} className="small"><ArrowLeft size={14} aria-hidden style={{ verticalAlign: 'middle' }} /> Integração de Clientes</Link>
      <PageHeader
        title={`${i.company.name} — ${i.system.name}`}
        subtitle={<span className="row" style={{ gap: 8, flexWrap: 'wrap' }}><StatusBadge status={i.status} />{i.archived && <span className="badge">Arquivada</span>}{i.overdue && <span className="badge badge-danger"><AlertTriangle size={12} aria-hidden /> Próxima ação vencida</span>}<span className="small muted">Criado em {formatDateTime(i.createdAt)} por {i.createdBy?.name} · última atualização {formatDateTime(i.updatedAt)}</span></span>}
        actions={!form ? (
          <div className="btn-group" style={{ flexWrap: 'wrap' }}>
            {editable && <Button variant="cta" onClick={startEdit}><Pencil size={16} aria-hidden /> Alterar</Button>}
            {!i.archived && i.status !== 'finalizado' && can('integrations.finish') && <Button onClick={() => setDialog('finish')}><CheckCircle2 size={16} aria-hidden /> Finalizar</Button>}
            {!i.archived && i.status === 'finalizado' && can('integrations.reopen') && <Button onClick={() => setDialog('reopen')}><RotateCcw size={16} aria-hidden /> Reabrir</Button>}
            {can('integrations.archive') && (i.archived ? <Button onClick={() => setDialog('restore')}>Restaurar</Button> : <Button onClick={() => setDialog('archive')}><Archive size={16} aria-hidden /> Arquivar</Button>)}
          </div>
        ) : undefined}
      />
      {conflict && (
        <Alert kind="warning" title="Este card foi atualizado por outra pessoa">
          <p>Suas alterações não foram salvas para não sobrescrever os dados mais recentes.</p>
          <Button size="sm" onClick={async () => { await reload(); setForm(null); setConflict(false); setError(null); }}>Recarregar dados atuais</Button>
        </Alert>
      )}
      {form ? (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
          <IntegrationFields form={form} onChange={(p) => setForm((f) => (f ? { ...f, ...p } : f))} errors={errors} mode="edit" lookups={lookups.data} canFinishDate={can('integrations.finish')} />
          {error && !conflict && <Alert kind="danger">{error}</Alert>}
          <div className="btn-group"><Button type="submit" variant="primary" loading={busy} disabled={conflict}><Save size={16} aria-hidden /> Salvar alterações</Button><Button onClick={cancel}>Cancelar</Button></div>
        </form>
      ) : (
        <div className="stack" style={{ gap: 24 }}>
          <section className="card card-body" aria-label="Resumo">
            <dl className="grid grid-3 small" style={{ margin: 0 }} data-testid="integration-summary">
              <div><dt className="muted">Empresa</dt><dd>{i.company.name}</dd></div>
              <div><dt className="muted">TMS</dt><dd>{i.system.name}</dd></div>
              <div><dt className="muted">Status</dt><dd><StatusBadge status={i.status} /></dd></div>
              <div style={{ gridColumn: '1 / -1' }}><dt className="muted">Objetivo</dt><dd><FormattedText text={i.objective} /></dd></div>
              <div><dt className="muted">CS/GC da conta</dt><dd>{i.csGc.name}</dd></div>
              <div><dt className="muted">Responsável operacional</dt><dd>{i.operator?.name ?? '—'}</dd></div>
              <div><dt className="muted">Data de início</dt><dd>{dateOnly(i.startedOn)}</dd></div>
              <div><dt className="muted">Previsão de conclusão</dt><dd>{dateOnly(i.expectedEndOn)}</dd></div>
              <div><dt className="muted">Data de finalização</dt><dd>{dateOnly(i.finishedOn)}</dd></div>
              <div style={{ gridColumn: '1 / -1' }}>
                <dt className="muted row" style={{ gap: 4 }}><CalendarClock size={14} aria-hidden /> Próxima ação</dt>
                <dd>{i.nextAction ? <>{i.nextAction}{i.nextActionOwner && <> · {i.nextActionOwner.name}</>}{i.nextActionDue && <> · <span className={i.overdue ? 'text-danger' : ''}>{dateOnly(i.nextActionDue)}{i.overdue && ' (vencida)'}</span></>}{i.nextActionNotes && <div className="muted">{i.nextActionNotes}</div>}</> : '—'}</dd>
              </div>
              {i.notes && <div style={{ gridColumn: '1 / -1' }}><dt className="muted">Observações gerais</dt><dd><FormattedText text={i.notes} /></dd></div>}
            </dl>
          </section>
          {i.status === 'finalizado' && (
            <section className="card card-body" aria-label="Finalização">
              <strong>Resultado da finalização</strong>
              <div className="small"><FormattedText text={i.resultSummary} /></div>
              {i.finalNotes && <div className="small"><strong>Observações finais:</strong> {i.finalNotes}</div>}
              {i.remainingPending && <div className="small"><strong>Pendências remanescentes:</strong> {i.remainingPending}</div>}
              <div className="tiny muted">Finalizada por {i.finishedBy?.name ?? '—'}</div>
            </section>
          )}
          <section aria-labelledby="desc-title"><h2 id="desc-title">Descrição</h2><div className="card card-body"><FormattedText text={i.description} /></div></section>
          <ActivitiesSection integration={i} lookups={lookups.data} />
          {can('integrations.history') && <ChangesSection id={i.id} />}
        </div>
      )}
      {dialog === 'finish' && <FinishDialog integration={i} onClose={() => setDialog(null)} onDone={afterAction('Integração finalizada.')} />}
      {dialog === 'reopen' && <ReopenDialog integration={i} onClose={() => setDialog(null)} onDone={afterAction('Integração reaberta.')} />}
      {dialog === 'archive' && <ConfirmDialog title="Arquivar integração?" message="O card sai da listagem principal; o histórico é preservado e ele pode ser restaurado." confirmLabel="Arquivar" onCancel={() => setDialog(null)} onConfirm={async () => { await post(`/api/integrations/${i.id}/archive`, { version: i.version }); await afterAction('Integração arquivada.')(); }} />}
      {dialog === 'restore' && <ConfirmDialog title="Restaurar integração?" message="O card voltará à listagem principal." confirmLabel="Restaurar" onCancel={() => setDialog(null)} onConfirm={async () => { await post(`/api/integrations/${i.id}/restore`, { version: i.version }); await afterAction('Integração restaurada.')(); }} />}
      {dialog === 'discard' && <ConfirmDialog title="Descartar alterações?" message="As modificações não salvas serão perdidas e os valores originais restaurados." confirmLabel="Descartar" danger onCancel={() => setDialog(null)} onConfirm={() => { setForm(null); setDialog(null); setErrors({}); setError(null); }} />}
      {blocker.state === 'blocked' && <ConfirmDialog title="Sair sem salvar?" message="Há alterações não salvas neste card." confirmLabel="Sair" danger onCancel={() => blocker.reset()} onConfirm={() => blocker.proceed()} />}
    </div>
  );
}

export type { ReactNode };
