import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { TICKET_PRIORITIES, TICKET_PRIORITY_LABELS } from '@shared/domain';
import { get, qs } from '../../lib/api';
import { formatDateTime, relativeTime } from '../../lib/format';
import type { Taxonomy, TicketSummary } from '../../lib/types';
import { useAuth } from '../../context/AuthContext';
import { PageHeader } from '../../components/Layout';
import { Empty, Field, Spinner, StatusBadge } from '../../components/ui';

const PENDING = ['waiting_user', 'waiting_technical', 'triage'];
const OPEN = ['open', 'in_progress'];
const DONE = ['resolved', 'closed'];

function Section({ title, hint, color, items, id }: { title: string; hint: string; color: string; items: TicketSummary[]; id: string }) {
  return (
    <section className="card" aria-labelledby={id} data-testid={`queue-${id}`}>
      <div className="group-head" style={{ borderLeftColor: color }}>
        <h2 id={id}>{title}</h2>
        <span className="pill">{items.length}</span>
        <span className="small muted">{hint}</span>
      </div>
      {items.length === 0 ? (
        <p className="small muted" style={{ padding: '0 20px 16px', margin: 0 }}>Nenhum ticket nesta seção.</p>
      ) : (
        <div className="table-wrap" style={{ border: 0 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Protocolo</th>
                <th>Título</th>
                <th>Solicitante</th>
                <th>Empresa</th>
                <th>Sistema</th>
                <th>Atualização</th>
                <th>Status</th>
                <th>Prioridade</th>
                <th>Responsável</th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td style={{ whiteSpace: 'nowrap' }}><Link to={`/interno/tickets/${t.id}`}>{t.protocol}</Link></td>
                  <td><Link to={`/interno/tickets/${t.id}`} style={{ fontWeight: 500 }}>{t.title}</Link></td>
                  <td>{t.requester}</td>
                  <td>{t.company}</td>
                  <td>{t.system}</td>
                  <td title={formatDateTime(t.updatedAt)} style={{ whiteSpace: 'nowrap' }}>{relativeTime(t.updatedAt)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}><StatusBadge status={t.status} /></td>
                  <td style={{ whiteSpace: 'nowrap' }}><StatusBadge status={t.priority} /></td>
                  <td>{t.assignee ?? <span className="muted">Sem responsável</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Fila do suporte: pendentes → em aberto → finalizados (ordem obrigatória). */
export function SupportQueuePage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const f = { q: params.get('q') ?? '', priority: params.get('priority') ?? '', system: params.get('system') ?? '', assignee: params.get('assignee') ?? '' };
  const taxonomy = useQuery({ queryKey: ['taxonomy'], queryFn: () => get<Taxonomy>('/api/taxonomy') });
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => get<{ items: Array<{ id: string; name: string }> }>('/api/users/agents'), enabled: can('tickets.manage') });
  const list = useQuery({
    queryKey: ['support-tickets', f],
    queryFn: () => get<{ total: number; items: TicketSummary[] }>(`/api/support/tickets${qs({ ...f, status: '', page: 1, pageSize: 100, sort: 'updated_desc' })}`),
    refetchInterval: 30_000,
  });
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const items = list.data?.items ?? [];
  const groups = useMemo(
    () => ({
      pending: items.filter((t) => PENDING.includes(t.status)),
      open: items.filter((t) => OPEN.includes(t.status)),
      done: items.filter((t) => DONE.includes(t.status)),
      unassigned: items.filter((t) => !t.assignee && !DONE.includes(t.status)).length,
    }),
    [items],
  );

  return (
    <div className="page">
      <PageHeader title="Tickets" subtitle="Fila completa do suporte: pendentes primeiro, depois em aberto e, por último, os finalizados." />
      <div className="stat-grid" data-testid="queue-stats">
        <div className="stat-card" style={{ ['--accent' as string]: '#d89a12' }}><strong>{groups.pending.length}</strong><span>Pendentes</span></div>
        <div className="stat-card" style={{ ['--accent' as string]: '#0787e8' }}><strong>{groups.open.length}</strong><span>Em aberto</span></div>
        <div className="stat-card" style={{ ['--accent' as string]: '#b3261e' }}><strong>{groups.unassigned}</strong><span>Sem responsável</span></div>
        <div className="stat-card" style={{ ['--accent' as string]: '#6a6a6a' }}><strong>{groups.done.length}</strong><span>Finalizados</span></div>
      </div>
      <div className="card card-body" style={{ marginBottom: 20 }}>
        <form className="grid grid-4" onSubmit={(e) => (e.preventDefault(), set('q', text.trim()))}>
          <Field label="Protocolo, título ou solicitante" htmlFor="sq-q">
            <input id="sq-q" className="input" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => set('q', text.trim())} />
          </Field>
          <Field label="Sistema" htmlFor="sq-sys">
            <select id="sq-sys" className="select" value={f.system} onChange={(e) => set('system', e.target.value)}>
              <option value="">Todos</option>
              {taxonomy.data?.systems.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Responsável" htmlFor="sq-assignee">
            <select id="sq-assignee" className="select" value={f.assignee} onChange={(e) => set('assignee', e.target.value)}>
              <option value="">Todos</option>
              <option value="me">Atribuídos a mim</option>
              <option value="none">Sem responsável</option>
              {agents.data?.items.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="Prioridade" htmlFor="sq-prio">
            <select id="sq-prio" className="select" value={f.priority} onChange={(e) => set('priority', e.target.value)}>
              <option value="">Todas</option>
              {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{TICKET_PRIORITY_LABELS[p]}</option>)}
            </select>
          </Field>
        </form>
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <div className="card"><Empty title="Nenhum ticket encontrado." /></div>
      ) : (
        <div className="stack" style={{ gap: 24 }}>
          <Section id="pendentes" title="Pendentes" hint="Aguardando usuário, equipe técnica ou triagem" color="#d89a12" items={groups.pending} />
          <Section id="em-aberto" title="Em aberto" hint="Abertos e em atendimento" color="#0787e8" items={groups.open} />
          <Section id="finalizados" title="Finalizados" hint="Resolvidos e fechados" color="#9a9a9a" items={groups.done} />
        </div>
      )}
    </div>
  );
}
