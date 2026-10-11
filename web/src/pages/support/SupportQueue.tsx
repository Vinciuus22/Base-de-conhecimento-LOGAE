import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Headset } from 'lucide-react';
import { TICKET_PRIORITIES, TICKET_PRIORITY_LABELS, TICKET_STATUSES, TICKET_STATUS_LABELS } from '@shared/domain';
import { get, qs } from '../../lib/api';
import { formatDateTime, relativeTime } from '../../lib/format';
import type { Taxonomy, TicketSummary } from '../../lib/types';
import { useAuth } from '../../context/AuthContext';
import { PageHeader } from '../../components/Layout';
import { Empty, Field, Pagination, Spinner, StatusBadge } from '../../components/ui';

export function SupportQueuePage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const f = {
    q: params.get('q') ?? '',
    status: params.get('status') ?? 'active',
    priority: params.get('priority') ?? '',
    category: params.get('category') ?? '',
    system: params.get('system') ?? '',
    assignee: params.get('assignee') ?? '',
    sort: params.get('sort') ?? 'updated_desc',
    page: Number(params.get('page') ?? 1),
  };
  const taxonomy = useQuery({ queryKey: ['taxonomy'], queryFn: () => get<Taxonomy>('/api/taxonomy') });
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => get<{ items: Array<{ id: string; name: string }> }>('/api/users/agents'), enabled: can('tickets.manage') });
  const list = useQuery({
    queryKey: ['support-tickets', f],
    queryFn: () => get<{ total: number; counts: Record<string, number>; items: TicketSummary[] }>(`/api/support/tickets${qs({ ...f, pageSize: 20 })}`),
    refetchInterval: 30_000,
  });
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== 'page') next.delete('page');
    setParams(next);
  };

  return (
    <div className="page">
      <PageHeader
        title="Atendimento de tickets"
        subtitle={can('tickets.manage') ? 'Todos os tickets (administração).' : 'Tickets sem responsável e atribuídos a você.'}
        icon={<Headset size={24} aria-hidden />}
      />
      {list.data && (
        <div className="row" style={{ marginBottom: 12 }}>
          {TICKET_STATUSES.map((s) => (
            <button key={s} type="button" className="btn btn-sm" aria-pressed={f.status === s} onClick={() => set('status', f.status === s ? 'active' : s)} style={f.status === s ? { background: 'var(--primary-soft)', borderColor: 'var(--primary)' } : undefined}>
              {TICKET_STATUS_LABELS[s]} <span className="badge">{list.data.counts[s] ?? 0}</span>
            </button>
          ))}
        </div>
      )}
      <div className="card card-body" style={{ marginBottom: 16 }}>
        <form className="grid grid-4" onSubmit={(e) => (e.preventDefault(), set('q', text.trim()))}>
          <Field label="Protocolo, usuário, empresa ou sistema" htmlFor="sq-q">
            <input id="sq-q" className="input" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => set('q', text.trim())} />
          </Field>
          <Field label="Status" htmlFor="sq-status">
            <select id="sq-status" className="select" value={f.status} onChange={(e) => set('status', e.target.value)}>
              <option value="active">Em aberto (não resolvidos)</option>
              <option value="">Todos</option>
              {TICKET_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {TICKET_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Prioridade" htmlFor="sq-prio">
            <select id="sq-prio" className="select" value={f.priority} onChange={(e) => set('priority', e.target.value)}>
              <option value="">Todas</option>
              {TICKET_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {TICKET_PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Responsável" htmlFor="sq-assignee">
            <select id="sq-assignee" className="select" value={f.assignee} onChange={(e) => set('assignee', e.target.value)}>
              <option value="">Todos</option>
              <option value="me">Atribuídos a mim</option>
              <option value="none">Sem responsável</option>
              {agents.data?.items.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Categoria" htmlFor="sq-cat">
            <select id="sq-cat" className="select" value={f.category} onChange={(e) => set('category', e.target.value)}>
              <option value="">Todas</option>
              {taxonomy.data?.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Sistema" htmlFor="sq-sys">
            <select id="sq-sys" className="select" value={f.system} onChange={(e) => set('system', e.target.value)}>
              <option value="">Todos</option>
              {taxonomy.data?.systems.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Ordenar por" htmlFor="sq-sort">
            <select id="sq-sort" className="select" value={f.sort} onChange={(e) => set('sort', e.target.value)}>
              <option value="updated_desc">Atualização mais recente</option>
              <option value="created_asc">Mais antigos primeiro</option>
              <option value="priority">Prioridade</option>
              <option value="status">Status</option>
            </select>
          </Field>
        </form>
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : !list.data?.items.length ? (
        <div className="card">
          <Empty title="Nenhum ticket encontrado." />
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Protocolo</th>
                <th>Título</th>
                <th>Solicitante</th>
                <th>Empresa</th>
                <th>Sistema</th>
                <th>Status</th>
                <th>Prioridade</th>
                <th>Responsável</th>
                <th>Atualização</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link to={`/interno/tickets/${t.id}`}>{t.protocol}</Link>
                  </td>
                  <td>
                    <Link to={`/interno/tickets/${t.id}`} style={{ fontWeight: 500 }}>
                      {t.title}
                    </Link>
                  </td>
                  <td>{t.requester}</td>
                  <td>{t.company}</td>
                  <td>{t.system}</td>
                  <td>
                    <StatusBadge status={t.status} />
                  </td>
                  <td>
                    <StatusBadge status={t.priority} />
                  </td>
                  <td>{t.assignee ?? <span className="muted">—</span>}</td>
                  <td title={formatDateTime(t.updatedAt)} style={{ whiteSpace: 'nowrap' }}>
                    {relativeTime(t.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data && <Pagination page={f.page} pageSize={20} total={list.data.total} onChange={(p) => set('page', String(p))} />}
    </div>
  );
}
