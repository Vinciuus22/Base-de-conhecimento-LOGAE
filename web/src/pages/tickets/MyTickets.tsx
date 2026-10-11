import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, Plus } from 'lucide-react';
import { TICKET_STATUSES, TICKET_STATUS_LABELS } from '@shared/domain';
import { get, qs } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import type { TicketSummary } from '../../lib/types';
import { useAuth } from '../../context/AuthContext';
import { PageHeader } from '../../components/Layout';
import { Alert, Empty, Field, Pagination, Spinner, StatusBadge } from '../../components/ui';

/** “Meus tickets”: todos os tickets do usuário, inclusive resolvidos e fechados. */
export function MyTicketsPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const filters = {
    q: params.get('q') ?? '',
    status: params.get('status') ?? '',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    sort: params.get('sort') ?? 'updated_desc',
    scope: params.get('scope') ?? 'mine',
    page: Number(params.get('page') ?? 1),
  };
  const list = useQuery({
    queryKey: ['my-tickets', filters],
    queryFn: () => get<{ total: number; canViewCompany: boolean; items: TicketSummary[] }>(`/api/tickets/mine${qs({ ...filters, pageSize: 15 })}`),
    enabled: !!user,
  });
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== 'page') next.delete('page');
    setParams(next);
  };

  if (!user) {
    return (
      <div className="page page-narrow">
        <Alert kind="info" title="Entre para ver seus tickets">
          <Link to="/entrar?voltar=/tickets">Entrar</Link>
        </Alert>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Meus tickets"
        subtitle="Acompanhe todos os seus atendimentos, inclusive os já resolvidos e fechados."
        icon={<ClipboardList size={24} aria-hidden />}
        actions={
          <Link className="btn btn-primary" to="/tickets/novo">
            <Plus size={16} aria-hidden /> Abrir ticket
          </Link>
        }
      />
      <div className="card card-body" style={{ marginBottom: 16 }}>
        <form
          className="grid grid-4"
          onSubmit={(e) => {
            e.preventDefault();
            set('q', text.trim());
          }}
        >
          <Field label="Protocolo ou título" htmlFor="mt-q">
            <input id="mt-q" className="input" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => set('q', text.trim())} placeholder="Pesquisar…" />
          </Field>
          <Field label="Status" htmlFor="mt-status">
            <select id="mt-status" className="select" value={filters.status} onChange={(e) => set('status', e.target.value)}>
              <option value="">Todos</option>
              {TICKET_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {TICKET_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Abertos a partir de" htmlFor="mt-from">
            <input id="mt-from" type="date" className="input" value={filters.from} onChange={(e) => set('from', e.target.value)} />
          </Field>
          <Field label="Até" htmlFor="mt-to">
            <input id="mt-to" type="date" className="input" value={filters.to} onChange={(e) => set('to', e.target.value)} />
          </Field>
          <Field label="Ordenar por" htmlFor="mt-sort">
            <select id="mt-sort" className="select" value={filters.sort} onChange={(e) => set('sort', e.target.value)}>
              <option value="updated_desc">Atualização mais recente</option>
              <option value="updated_asc">Atualização mais antiga</option>
              <option value="created_desc">Abertura mais recente</option>
              <option value="created_asc">Abertura mais antiga</option>
              <option value="status">Status</option>
            </select>
          </Field>
          {list.data?.canViewCompany && (
            <Field label="Exibir" htmlFor="mt-scope">
              <select id="mt-scope" className="select" value={filters.scope} onChange={(e) => set('scope', e.target.value)}>
                <option value="mine">Meus tickets</option>
                <option value="company">Tickets da minha empresa</option>
              </select>
            </Field>
          )}
        </form>
      </div>

      {list.isLoading ? (
        <Spinner />
      ) : !list.data || list.data.items.length === 0 ? (
        <div className="card">
          <Empty title="Nenhum ticket encontrado.">
            <Link to="/tickets/novo" className="btn btn-primary" style={{ marginTop: 8 }}>
              Abrir ticket
            </Link>
          </Empty>
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Protocolo</th>
                <th>Título</th>
                <th>Sistema</th>
                {filters.scope === 'company' && <th>Solicitante</th>}
                <th>Empresa</th>
                <th>Abertura</th>
                <th>Última atualização</th>
                <th>Status</th>
                <th>Prioridade</th>
                <th>Responsável</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link to={`/tickets/${t.id}`}>{t.protocol}</Link>
                  </td>
                  <td>
                    <Link to={`/tickets/${t.id}`} style={{ fontWeight: 500 }}>
                      {t.title}
                    </Link>
                  </td>
                  <td>{t.system}</td>
                  {filters.scope === 'company' && <td>{t.requester}</td>}
                  <td>{t.company}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(t.createdAt)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(t.updatedAt)}</td>
                  <td>
                    <StatusBadge status={t.status} />
                  </td>
                  <td>
                    <StatusBadge status={t.priority} />
                  </td>
                  <td>{t.assignee ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data && <Pagination page={filters.page} pageSize={15} total={list.data.total} onChange={(p) => set('page', String(p))} />}
    </div>
  );
}
