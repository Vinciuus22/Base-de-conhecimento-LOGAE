import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get } from '../../lib/api';
import { formatDate, formatDateTime } from '../../lib/format';
import type { TicketSummary } from '../../lib/types';
import { useAuth } from '../../context/AuthContext';
import { PageHeader } from '../../components/Layout';
import { Alert, Empty, Spinner, StatusBadge } from '../../components/ui';

const FINISHED = new Set(['resolved', 'closed']);
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function TicketLink({ t }: { t: TicketSummary }) {
  return (
    <Link to={`/tickets/${t.id}`} style={{ fontWeight: 500 }}>
      {t.title}
    </Link>
  );
}

/** “Meus tickets”: indicadores, pendentes/em aberto e finalizados (com busca própria). */
export function MyTicketsPage() {
  const { user } = useAuth();
  const [scope, setScope] = useState<'mine' | 'company'>('mine');
  const [closedQuery, setClosedQuery] = useState('');
  const list = useQuery({
    queryKey: ['my-tickets', scope],
    queryFn: () => get<{ total: number; canViewCompany: boolean; items: TicketSummary[] }>(`/api/tickets/mine?pageSize=100&scope=${scope}&sort=updated_desc`),
    enabled: !!user,
  });
  const items = list.data?.items ?? [];
  const { open, finished, waitingUser, inService } = useMemo(() => {
    const open = items.filter((t) => !FINISHED.has(t.status));
    return {
      open,
      finished: items.filter((t) => FINISHED.has(t.status)),
      waitingUser: open.filter((t) => t.status === 'waiting_user').length,
      inService: open.filter((t) => t.status === 'in_progress').length,
    };
  }, [items]);
  const closedShown = finished.filter((t) => !closedQuery.trim() || norm(`${t.protocol} ${t.title} ${t.system}`).includes(norm(closedQuery.trim())));

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
        subtitle="Seus atendimentos: pendentes e em aberto primeiro, finalizados na busca abaixo."
        actions={
          <Link className="btn btn-cta" to="/tickets/novo">
            Abrir ticket
          </Link>
        }
      />
      {list.data?.canViewCompany && (
        <div className="row" style={{ marginBottom: 12 }}>
          <label className="row" style={{ gap: 8 }}>
            Exibir
            <select className="select" style={{ width: 'auto' }} value={scope} onChange={(e) => setScope(e.target.value as 'mine' | 'company')}>
              <option value="mine">Meus tickets</option>
              <option value="company">Tickets da minha empresa</option>
            </select>
          </label>
        </div>
      )}
      <div className="stat-grid" data-testid="ticket-stats">
        <div className="stat-card" style={{ ['--accent' as string]: '#0787e8' }}><strong>{open.length}</strong><span>Em aberto</span></div>
        <div className="stat-card" style={{ ['--accent' as string]: '#d89a12' }}><strong>{waitingUser}</strong><span>Aguardando você</span></div>
        <div className="stat-card" style={{ ['--accent' as string]: '#19b987' }}><strong>{inService}</strong><span>Em atendimento</span></div>
        <div className="stat-card" style={{ ['--accent' as string]: '#6a6a6a' }}><strong>{finished.length}</strong><span>Finalizados</span></div>
      </div>

      {list.isLoading ? (
        <Spinner />
      ) : (
        <div className="stack" style={{ gap: 24 }}>
          <section className="card" aria-labelledby="mt-open">
            <div className="section-card-title">
              <h2 id="mt-open">Pendentes e em aberto</h2>
              <p>Tickets que ainda aguardam alguma ação.</p>
            </div>
            {open.length === 0 ? (
              <Empty title="Nenhum ticket em aberto.">
                <Link to="/tickets/novo" className="btn btn-primary" style={{ marginTop: 8 }}>
                  Abrir ticket
                </Link>
              </Empty>
            ) : (
              <div className="table-wrap" style={{ border: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Protocolo</th>
                      <th>Título</th>
                      <th>Sistema</th>
                      {scope === 'company' && <th>Solicitante</th>}
                      <th>Abertura</th>
                      <th>Atualização</th>
                      <th>Status</th>
                      <th>Prioridade</th>
                    </tr>
                  </thead>
                  <tbody>
                    {open.map((t) => (
                      <tr key={t.id}>
                        <td style={{ whiteSpace: 'nowrap' }}><Link to={`/tickets/${t.id}`}>{t.protocol}</Link></td>
                        <td><TicketLink t={t} /></td>
                        <td>{t.system}</td>
                        {scope === 'company' && <td>{t.requester}</td>}
                        <td style={{ whiteSpace: 'nowrap' }}>{formatDate(t.createdAt)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(t.updatedAt)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}><StatusBadge status={t.status} /></td>
                        <td style={{ whiteSpace: 'nowrap' }}><StatusBadge status={t.priority} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card" aria-labelledby="mt-closed">
            <div className="section-card-title">
              <h2 id="mt-closed">Finalizados</h2>
              <p>Tickets resolvidos ou fechados. Use a busca para encontrá-los.</p>
            </div>
            <div style={{ padding: '14px 20px' }}>
              <label htmlFor="mt-closed-q" className="sr-only">
                Pesquisar tickets finalizados
              </label>
              <input id="mt-closed-q" className="input" placeholder="Protocolo, título ou sistema" value={closedQuery} onChange={(e) => setClosedQuery(e.target.value)} />
            </div>
            {closedShown.length === 0 ? (
              <p className="small muted" style={{ padding: '0 20px 20px', margin: 0 }}>Nenhum ticket finalizado corresponde à pesquisa.</p>
            ) : (
              <div className="table-wrap" style={{ border: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Protocolo</th>
                      <th>Título</th>
                      <th>Sistema</th>
                      <th>Encerramento</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {closedShown.map((t) => (
                      <tr key={t.id}>
                        <td style={{ whiteSpace: 'nowrap' }}><Link to={`/tickets/${t.id}`}>{t.protocol}</Link></td>
                        <td><TicketLink t={t} /></td>
                        <td>{t.system}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{formatDate(t.updatedAt)}</td>
                        <td><StatusBadge status={t.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
