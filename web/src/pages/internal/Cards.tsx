import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowDownUp, ArrowLeft, CheckCircle2, ChevronDown, ChevronUp, ExternalLink, History, KanbanSquare, RefreshCw, UserX, Users } from 'lucide-react';
import { errorMessage, get, post, qs } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useAuth } from '../../context/AuthContext';
import { PageHeader } from '../../components/Layout';
import { Alert, Button, Empty, Field, Pagination, Spinner, useToast } from '../../components/ui';

const REFRESH_MS = 60_000;

export const EVENT_TYPE_LABELS: Record<string, string> = {
  status_change: 'Mudança de status',
  assignee_change: 'Mudança de responsável',
  description_change: 'Descrição alterada',
  priority_change: 'Prioridade alterada',
  field_change: 'Campo alterado',
  comment: 'Novo comentário',
  comment_edited: 'Comentário editado',
  comment_deleted: 'Comentário removido',
  card_created: 'Card criado',
};
/** Cor derivada do nome do status: status novos do Jira caem no neutro. */
export function statusTone(name: string | null): string {
  const n = (name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (/pronto|conclu|done|finaliz/.test(n)) return 'badge-success';
  if (/backlog/.test(n)) return '';
  if (/para desenvolver|desenvolvimento/.test(n)) return 'badge-warning';
  if (/code review|validacao|testar|teste/.test(n)) return 'badge-purple';
  if (/deploy|atualizar/.test(n)) return 'badge-info';
  return '';
}
const typeLabel = (t: string | null) => (t ? (EVENT_TYPE_LABELS[t] ?? t) : '—');

interface SyncInfo {
  lastSuccessAt: string | null;
  lastRun: { kind: string; status: string; startedAt: string; finishedAt: string | null; cards: number; events: number; error: string | null } | null;
  stale: boolean;
  state: 'ok' | 'stale' | 'failed' | 'partial' | 'not_configured';
  apiConfigured: boolean;
  webhookConfigured: boolean;
  projects: string[];
  autoSyncMinutes: number;
  webhookPath: string;
}
interface CardItem {
  id: string;
  key: string;
  title: string;
  description: string;
  projectKey: string;
  projectName: string | null;
  boardName: string | null;
  status: string | null;
  priority: string | null;
  assignee: string | null;
  reporter: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  lastChangeAt: string | null;
  lastEventType: string | null;
  lastEventAuthor: string | null;
  lastEventShared: boolean;
  lastSyncedAt: string;
  historyComplete: boolean;
  historyNote: string | null;
  url: string | null;
}
interface CardList {
  total: number;
  items: CardItem[];
  facets: { projects: Array<{ key: string; name: string | null; count: number }>; statuses: Array<{ name: string; count: number }>; assignees: string[]; authors: string[]; eventTypes: string[] };
  sync: SyncInfo;
}
interface CardEvent {
  id: string;
  jiraEventId: string | null;
  type: string;
  field: string | null;
  from: string | null;
  to: string | null;
  comment: string | null;
  commentRestricted: boolean;
  author: string | null;
  authorAccountId: string | null;
  authorShared: boolean;
  occurredAt: string;
  syncedAt: string;
  summary: string;
}
interface EventList {
  total: number;
  items: CardEvent[];
  facets: { authors: string[]; types: string[]; fields: string[] };
}

function SyncBanner({ sync }: { sync: SyncInfo }) {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const run = useMutation({
    mutationFn: () => post<{ status: string; cards: number; events: number; errors: string[] }>('/api/cards/sync'),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: ['cards'] });
      void queryClient.invalidateQueries({ queryKey: ['card'] });
      toast(r.status === 'success' ? 'success' : 'error', r.status === 'success' ? `Sincronizado: ${r.cards} cards, ${r.events} novos eventos.` : `Sincronização ${r.status === 'partial' ? 'parcial' : 'com falha'}: ${r.errors[0] ?? ''}`);
    },
    onError: (e) => toast('error', errorMessage(e)),
  });
  const bad = sync.state !== 'ok';
  const text = {
    ok: `Integração Jira ativa${sync.webhookConfigured ? ' — webhook' : ''}${sync.autoSyncMinutes > 0 ? ` + varredura a cada ${sync.autoSyncMinutes} min` : ''}`,
    stale: 'Os dados podem estar desatualizados: não há sincronização recente.',
    failed: 'A última sincronização falhou; exibindo os últimos dados salvos.',
    partial: 'A última sincronização foi parcial; parte do histórico pode estar incompleta.',
    not_configured: 'Integração com o Jira não configurada.',
  }[sync.state];
  return (
    <div className="card sync-banner" role="status" data-testid="sync-banner" style={{ ['--accent' as string]: bad ? '#b3261e' : '#19b987' }}>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <div>
          <strong className="row" style={{ gap: 8, fontWeight: 500 }}>
            <span className="status-dot" aria-hidden /> {text}
          </strong>
          <div className="tiny muted">
            Última sincronização bem-sucedida: {sync.lastSuccessAt ? formatDateTime(sync.lastSuccessAt) : 'nunca'} · projetos {sync.projects.join(' e ')}
          </div>
          {sync.lastRun?.error && <div className="tiny" style={{ color: '#8c1d18' }}>Erro registrado: {sync.lastRun.error.split('\n')[0]}</div>}
        </div>
        {can('cards.sync') && (
          <Button size="sm" onClick={() => run.mutate()} loading={run.isPending} disabled={!sync.apiConfigured}>
            {run.isPending ? 'Sincronizando…' : 'Sincronizar agora'}
          </Button>
        )}
      </div>
    </div>
  );
}

export function CardsPage() {
  const [params, setParams] = useSearchParams();
  const get_ = (k: string) => params.get(k) ?? '';
  const page = Number(params.get('page') ?? 1) || 1;
  const filters = { q: get_('q'), project: get_('project'), status: get_('status'), assignee: get_('assignee'), author: get_('author'), eventType: get_('eventType'), from: get_('from'), to: get_('to'), recent: get_('recent') };
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    next.delete('page');
    setParams(next, { replace: true });
  };
  const list = useQuery({
    queryKey: ['cards', filters, page],
    queryFn: () => get<CardList>(`/api/cards${qs({ ...filters, page, pageSize: 20 })}`),
    refetchInterval: REFRESH_MS,
    placeholderData: (prev) => prev,
  });
  const f = list.data?.facets;
  const selectedStatuses = filters.status ? filters.status.split(',') : [];
  const hasFilters = Object.values(filters).some(Boolean);
  const detailQuery = params.toString();

  return (
    <div className="page">
      <PageHeader title="Atualizações dos Cards" subtitle="Consulta aos cards monitorados nos quadros Jira. Somente leitura — alterações continuam sendo feitas no Jira." />
      {list.data && <SyncBanner sync={list.data.sync} />}
      <div className="card card-body" style={{ marginBottom: 16 }}>
        <div className="grid grid-4">
          <Field label="Pesquisar" htmlFor="cd-q">
            <input id="cd-q" className="input" placeholder="Chave, título, responsável ou autor" value={filters.q} onChange={(e) => set('q', e.target.value)} />
          </Field>
          <Field label="Projeto / quadro" htmlFor="cd-proj">
            <select id="cd-proj" className="select" value={filters.project} onChange={(e) => set('project', e.target.value)}>
              <option value="">Todos</option>
              {f?.projects.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.key}
                  {p.name ? ` — ${p.name}` : ''} ({p.count})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Responsável atual" htmlFor="cd-ass">
            <select id="cd-ass" className="select" value={filters.assignee} onChange={(e) => set('assignee', e.target.value)}>
              <option value="">Todos</option>
              <option value="__none__">Sem responsável</option>
              {f?.assignees.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Autor da alteração" htmlFor="cd-aut">
            <select id="cd-aut" className="select" value={filters.author} onChange={(e) => set('author', e.target.value)}>
              <option value="">Todos</option>
              {f?.authors.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tipo de evento" htmlFor="cd-type">
            <select id="cd-type" className="select" value={filters.eventType} onChange={(e) => set('eventType', e.target.value)}>
              <option value="">Todos</option>
              {f?.eventTypes.map((t) => (
                <option key={t} value={t}>
                  {typeLabel(t)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Atualizados" htmlFor="cd-rec">
            <select id="cd-rec" className="select" value={filters.recent} onChange={(e) => set('recent', e.target.value)}>
              <option value="">Qualquer período</option>
              <option value="1">Últimas 24 horas</option>
              <option value="7">Últimos 7 dias</option>
              <option value="30">Últimos 30 dias</option>
            </select>
          </Field>
          <Field label="Data inicial" htmlFor="cd-from">
            <input id="cd-from" type="date" className="input" value={filters.from} onChange={(e) => set('from', e.target.value)} />
          </Field>
          <Field label="Data final" htmlFor="cd-to">
            <input id="cd-to" type="date" className="input" value={filters.to} onChange={(e) => set('to', e.target.value)} />
          </Field>
        </div>
        <fieldset style={{ border: 0, padding: 0, margin: '12px 0 0' }}>
          <legend className="label">Status (um ou mais)</legend>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {f?.statuses.map((s) => {
              const on = selectedStatuses.includes(s.name);
              return (
                <button
                  key={s.name}
                  type="button"
                  className={`chip ${on ? 'chip-active' : ''}`}
                  aria-pressed={on}
                  onClick={() => set('status', (on ? selectedStatuses.filter((x) => x !== s.name) : [...selectedStatuses, s.name]).join(','))}
                >
                  {s.name} ({s.count})
                </button>
              );
            })}
          </div>
        </fieldset>
        {hasFilters && (
          <div style={{ marginTop: 12 }}>
            <Button size="sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
              Limpar filtros
            </Button>
          </div>
        )}
      </div>

      {list.isLoading ? (
        <Spinner />
      ) : list.isError ? (
        <Alert kind="danger">{errorMessage(list.error)}</Alert>
      ) : !list.data?.items.length ? (
        <div className="card">
          <Empty title={hasFilters ? 'Nenhum card encontrado com os filtros aplicados.' : 'Nenhum card sincronizado ainda.'}>
            {!hasFilters && <p className="small muted">Os cards aparecem após o primeiro webhook ou a primeira sincronização com o Jira.</p>}
          </Empty>
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table" data-testid="cards-table">
            <thead>
              <tr>
                <th>Chave</th>
                <th>Título</th>
                <th>Projeto</th>
                <th>Status</th>
                <th>Responsável</th>
                <th>Última alteração</th>
                <th>Autor da alteração</th>
                <th>Tipo de alteração</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={`/interno/cards/${c.key}${detailQuery ? `?voltar=${encodeURIComponent(detailQuery)}` : ''}`}>
                      <strong>{c.key}</strong>
                    </Link>
                  </td>
                  <td>{c.title}</td>
                  <td>
                    {c.projectKey}
                    {c.boardName && <div className="tiny muted">{c.boardName}</div>}
                  </td>
                  <td>{c.status ? <span className={`badge ${statusTone(c.status)}`}>{c.status}</span> : <span className="muted">Não informado pelo Jira</span>}</td>
                  <td>{c.assignee ?? <span className="muted">Sem responsável</span>}</td>
                  <td>{formatDateTime(c.lastChangeAt)}</td>
                  <td>
                    {c.lastEventAuthor ?? <span className="muted">Não disponível</span>}
                    {c.lastEventShared && <div className="tiny muted">conta compartilhada</div>}
                  </td>
                  <td>{typeLabel(c.lastEventType)}</td>
                  <td>
                    <div className="btn-group">
                      <Link className="btn btn-sm" to={`/interno/cards/${c.key}${detailQuery ? `?voltar=${encodeURIComponent(detailQuery)}` : ''}`}>
                        <History size={14} aria-hidden /> Histórico
                      </Link>
                      {c.url && (
                        <a className="btn btn-sm" href={c.url} target="_blank" rel="noreferrer noopener" aria-label={`Abrir ${c.key} no Jira`}>
                          <ExternalLink size={14} aria-hidden /> Jira
                        </a>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data && <Pagination page={page} pageSize={20} total={list.data.total} onChange={(p) => { const n = new URLSearchParams(params); n.set('page', String(p)); setParams(n, { replace: true }); }} />}
    </div>
  );
}

function LongValue({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (text.length <= 160) return <span style={{ whiteSpace: 'pre-wrap' }}>{text}</span>;
  return (
    <span>
      <span style={{ whiteSpace: 'pre-wrap' }}>{open ? text : `${text.slice(0, 160)}…`}</span>{' '}
      <button type="button" className="btn btn-sm btn-ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? (<>Recolher <ChevronUp size={12} aria-hidden /></>) : (<>Expandir <ChevronDown size={12} aria-hidden /></>)}
      </button>
    </span>
  );
}

function EventItem({ e }: { e: CardEvent }) {
  const hasValues = e.from !== null || e.to !== null;
  return (
    <li className={`timeline-item timeline-${e.type}`} data-testid="card-event" style={{ borderLeft: '3px solid var(--border, #ccd)', padding: '8px 0 8px 14px', marginBottom: 8 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span className={`badge ${e.type === 'comment' || e.type === 'comment_edited' ? 'badge-success' : e.type === 'status_change' ? 'badge-info' : ''}`}>{typeLabel(e.type)}</span>
        <time dateTime={e.occurredAt} className="small muted">
          {formatDateTime(e.occurredAt)}
        </time>
      </div>
      <div className="small" style={{ marginTop: 4 }}>
        <strong>{e.summary}</strong>
      </div>
      {e.type === 'status_change' && hasValues && (
        <div style={{ marginTop: 4 }}>
          <code>{e.from ?? '(vazio)'}</code> → <code>{e.to ?? '(vazio)'}</code>
        </div>
      )}
      {e.type !== 'status_change' && e.field && e.type !== 'comment' && e.type !== 'comment_edited' && e.type !== 'comment_deleted' && hasValues && (
        <div className="small" style={{ marginTop: 4 }}>
          <span className="muted">Campo:</span> {e.field}
          <div>
            <span className="muted">Anterior:</span> {e.from ? <LongValue text={e.from} /> : '(vazio)'}
          </div>
          <div>
            <span className="muted">Novo:</span> {e.to ? <LongValue text={e.to} /> : '(vazio)'}
          </div>
        </div>
      )}
      {(e.type === 'comment' || e.type === 'comment_edited') && (
        <blockquote style={{ margin: '6px 0 0', paddingLeft: 10, borderLeft: '2px solid var(--border, #ccd)' }}>
          {e.commentRestricted ? <em className="muted">Comentário com acesso restrito no Jira — conteúdo não disponível aqui.</em> : e.comment ? <LongValue text={e.comment} /> : <em className="muted">Conteúdo não disponível.</em>}
        </blockquote>
      )}
      <div className="tiny muted" style={{ marginTop: 4 }}>
        {e.author ? (
          <>
            Autor registrado no Jira: <strong>{e.author}</strong>
            {e.authorShared && ' (conta compartilhada — não identifica uma pessoa específica)'}
            {e.authorAccountId && <> · conta {e.authorAccountId}</>}
          </>
        ) : (
          <span className="row" style={{ gap: 4 }}>
            <UserX size={12} aria-hidden /> Autor não disponível no Jira
          </span>
        )}
        {e.jiraEventId && <> · evento Jira #{e.jiraEventId}</>}
      </div>
    </li>
  );
}

export function CardDetailPage() {
  const { key = '' } = useParams();
  const [params] = useSearchParams();
  const [f, setF] = useState({ q: '', author: '', type: '', field: '', from: '', to: '', order: 'desc' });
  const [page, setPage] = useState(1);
  const set = (k: keyof typeof f, v: string) => {
    setF((x) => ({ ...x, [k]: v }));
    setPage(1);
  };
  const card = useQuery({ queryKey: ['card', key], queryFn: () => get<{ card: CardItem; sync: SyncInfo }>(`/api/cards/${key}`), refetchInterval: REFRESH_MS });
  const events = useQuery({
    queryKey: ['card-events', key, f, page],
    queryFn: () => get<EventList>(`/api/cards/${key}/events${qs({ ...f, page, pageSize: 25 })}`),
    refetchInterval: REFRESH_MS,
    placeholderData: (prev) => prev,
  });
  const back = params.get('voltar');
  if (card.isLoading) return <Spinner />;
  if (!card.data)
    return (
      <div className="page page-narrow">
        <Empty title="Card não encontrado.">
          <Link to="/interno/cards" className="btn">
            Voltar
          </Link>
        </Empty>
      </div>
    );
  const c = card.data.card;
  const fac = events.data?.facets;
  return (
    <div className="page" style={{ maxWidth: 1000 }}>
      <Link to={`/interno/cards${back ? `?${back}` : ''}`} className="small">
        <ArrowLeft size={14} aria-hidden style={{ verticalAlign: 'middle' }} /> Atualizações dos Cards
      </Link>
      <PageHeader
        title={`${c.key} — ${c.title}`}
        actions={
          c.url ? (
            <a className="btn btn-cta" href={c.url} target="_blank" rel="noreferrer noopener">
              <ExternalLink size={16} aria-hidden /> Abrir no Jira
            </a>
          ) : undefined
        }
      />
      <SyncBanner sync={card.data.sync} />
      {!c.historyComplete && (
        <Alert kind="warning">Histórico possivelmente incompleto. {c.historyNote ?? 'Aguarde a próxima sincronização completa.'}</Alert>
      )}
      <section className="card card-body" aria-label="Resumo do card" style={{ margin: '16px 0' }}>
        <dl className="grid grid-3 small" style={{ margin: 0 }}>
          <div><dt className="muted">Projeto</dt><dd>{c.projectKey}{c.projectName ? ` — ${c.projectName}` : ''}{c.boardName ? ` · ${c.boardName}` : ''}</dd></div>
          <div><dt className="muted">Status atual</dt><dd>{c.status ? <span className={`badge ${statusTone(c.status)}`}>{c.status}</span> : <span className="muted">Não informado pelo Jira</span>}</dd></div>
          <div><dt className="muted">Responsável atual</dt><dd>{c.assignee ?? 'Sem responsável'}</dd></div>
          <div><dt className="muted">Prioridade</dt><dd>{c.priority ?? 'Não informada'}</dd></div>
          <div><dt className="muted">Criado em</dt><dd>{formatDateTime(c.createdAt)}</dd></div>
          <div><dt className="muted">Última alteração</dt><dd>{formatDateTime(c.lastChangeAt)}</dd></div>
        </dl>
        {c.description && (
          <div style={{ marginTop: 12 }}>
            <strong className="small">Descrição</strong>
            <div className="small"><LongValue text={c.description} /></div>
          </div>
        )}
      </section>

      <section aria-labelledby="hist-title">
        <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <h2 id="hist-title" className="row" style={{ gap: 8 }}>
            <History size={20} aria-hidden /> Histórico de alterações {events.data && <span className="muted small">({events.data.total})</span>}
          </h2>
          <Button size="sm" onClick={() => set('order', f.order === 'desc' ? 'asc' : 'desc')} aria-label="Inverter ordenação">
            <ArrowDownUp size={14} aria-hidden /> {f.order === 'desc' ? 'Mais recentes primeiro' : 'Mais antigos primeiro'}
          </Button>
        </div>
        <div className="card card-body" style={{ margin: '8px 0 16px' }}>
          <div className="grid grid-4">
            <Field label="Pesquisar no histórico" htmlFor="ev-q">
              <input id="ev-q" className="input" value={f.q} onChange={(e) => set('q', e.target.value)} />
            </Field>
            <Field label="Autor" htmlFor="ev-aut">
              <select id="ev-aut" className="select" value={f.author} onChange={(e) => set('author', e.target.value)}>
                <option value="">Todos</option>
                <option value="__none__">Autor não disponível</option>
                {fac?.authors.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </Field>
            <Field label="Tipo de evento" htmlFor="ev-type">
              <select id="ev-type" className="select" value={f.type} onChange={(e) => set('type', e.target.value)}>
                <option value="">Todos</option>
                {fac?.types.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
              </select>
            </Field>
            <Field label="Campo alterado" htmlFor="ev-field">
              <select id="ev-field" className="select" value={f.field} onChange={(e) => set('field', e.target.value)}>
                <option value="">Todos</option>
                {fac?.fields.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </Field>
            <Field label="De" htmlFor="ev-from">
              <input id="ev-from" type="date" className="input" value={f.from} onChange={(e) => set('from', e.target.value)} />
            </Field>
            <Field label="Até" htmlFor="ev-to">
              <input id="ev-to" type="date" className="input" value={f.to} onChange={(e) => set('to', e.target.value)} />
            </Field>
          </div>
        </div>
        {events.isLoading ? (
          <Spinner />
        ) : !events.data?.items.length ? (
          <Empty title="Nenhum evento encontrado.">
            <p className="small muted">
              <Users size={14} aria-hidden style={{ verticalAlign: 'middle' }} /> O histórico exibe apenas eventos recuperados do Jira.
            </p>
          </Empty>
        ) : (
          <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {events.data.items.map((e) => <EventItem key={e.id} e={e} />)}
          </ol>
        )}
        {events.data && <Pagination page={page} pageSize={25} total={events.data.total} onChange={setPage} />}
      </section>
    </div>
  );
}
