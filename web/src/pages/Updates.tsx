import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, RefreshCw, Rocket } from 'lucide-react';
import { errorMessage, get, post, put, qs } from '../lib/api';
import { formatDate, formatDateTime } from '../lib/format';
import type { Taxonomy } from '../lib/types';
import { useAuth } from '../context/AuthContext';
import { PageHeader } from '../components/Layout';
import { Alert, Button, Empty, Field, Pagination, Spinner, useToast } from '../components/ui';

export interface UpdateItem {
  id: string;
  jiraKey: string;
  jiraUrl: string | null;
  title: string;
  description: string;
  release: string;
  visibility: 'internal' | 'external';
  system: { id: string; name: string } | null;
  completedAt: string | null;
  publishedAt: string | null;
  updatedAt: string;
  status?: 'published' | 'hidden';
  manualOverride?: boolean;
  audienceRaw?: string | null;
  jiraStatus?: string | null;
}
interface UpdateList {
  total: number;
  items: UpdateItem[];
  releases: string[];
}
interface Integration {
  webhookConfigured: boolean;
  apiConfigured: boolean;
  baseUrl: string | null;
  releaseField: string;
  audienceField: string;
  projects: string | null;
  autoSyncMinutes: number;
  webhookPath: string;
}

const AUDIENCE_LABEL = { internal: 'Interno', external: 'Clientes' } as const;

function UpdateList({ manage }: { manage: boolean }) {
  const [f, setF] = useState({ q: '', system: '', release: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const queryClient = useQueryClient();
  const toast = useToast();
  const taxonomy = useQuery({ queryKey: ['taxonomy'], queryFn: () => get<Taxonomy>('/api/taxonomy') });
  const list = useQuery({
    queryKey: ['updates', manage, f, page],
    queryFn: () => get<UpdateList>(`/api/updates${qs({ ...f, page, pageSize: 15, manage: manage ? '1' : undefined })}`),
  });
  const set = (k: keyof typeof f, v: string) => {
    setF((x) => ({ ...x, [k]: v }));
    setPage(1);
  };
  const change = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => put(`/api/updates/${id}`, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['updates'] });
      toast('success', 'Atualização ajustada.');
    },
    onError: (e) => toast('error', errorMessage(e)),
  });
  const giveBack = useMutation({
    mutationFn: (id: string) => post(`/api/updates/${id}/release-control`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['updates'] });
      toast('success', 'O Jira voltou a controlar esta atualização.');
    },
    onError: (e) => toast('error', errorMessage(e)),
  });

  return (
    <>
      <div className="card card-body" style={{ marginBottom: 16 }}>
        <div className="grid grid-4">
          <Field label="Pesquisar" htmlFor="up-q">
            <input id="up-q" className="input" value={f.q} onChange={(e) => set('q', e.target.value)} />
          </Field>
          <Field label="Sistema" htmlFor="up-sys">
            <select id="up-sys" className="select" value={f.system} onChange={(e) => set('system', e.target.value)}>
              <option value="">Todos</option>
              {taxonomy.data?.systems.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Release" htmlFor="up-rel">
            <select id="up-rel" className="select" value={f.release} onChange={(e) => set('release', e.target.value)}>
              <option value="">Todas</option>
              {list.data?.releases.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          <Field label="A partir de" htmlFor="up-from">
            <input id="up-from" type="date" className="input" value={f.from} onChange={(e) => set('from', e.target.value)} />
          </Field>
        </div>
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : !list.data?.items.length ? (
        <div className="card">
          <Empty title="Nenhuma atualização encontrada." />
        </div>
      ) : (
        <div className="card">
          {list.data.items.map((n) => (
            <article key={n.id} className="result" data-testid="update-item">
              <h3>
                <Link to={`/atualizacoes/${n.id}`}>{n.title}</Link>
              </h3>
              <div className="result-meta">
                <span className="badge badge-info">
                  <Rocket size={12} aria-hidden /> Release {n.release}
                </span>
                {n.system && <span className="badge">{n.system.name}</span>}
                {manage && <span className="badge">{n.jiraKey}</span>}
                {manage && <span className="badge">{AUDIENCE_LABEL[n.visibility]}</span>}
                {manage && n.status === 'hidden' && <span className="badge badge-warning">Oculta</span>}
                {manage && n.manualOverride && <span className="badge badge-warning">Ajuste manual</span>}
                <span>{formatDate(n.completedAt ?? n.publishedAt)}</span>
              </div>
              <p className="snippet">{n.description.slice(0, 240)}</p>
              {manage && (
                <div className="btn-group" style={{ marginTop: 8 }}>
                  <Button size="sm" onClick={() => change.mutate({ id: n.id, body: { status: n.status === 'hidden' ? 'published' : 'hidden' } })}>
                    {n.status === 'hidden' ? 'Exibir' : 'Ocultar'}
                  </Button>
                  <Button size="sm" onClick={() => change.mutate({ id: n.id, body: { visibility: n.visibility === 'internal' ? 'external' : 'internal' } })}>
                    Exibir para: {n.visibility === 'internal' ? 'clientes' : 'somente internos'}
                  </Button>
                  {n.manualOverride && (
                    <Button size="sm" onClick={() => giveBack.mutate(n.id)}>
                      Devolver ao Jira
                    </Button>
                  )}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
      {list.data && <Pagination page={page} pageSize={15} total={list.data.total} onChange={setPage} />}
    </>
  );
}

/** Tela de consulta (somente leitura): clientes e visitantes só visualizam. */
export function UpdatesPage() {
  const { can } = useAuth();
  return (
    <div className="page">
      <PageHeader
        title="Atualizações"
        subtitle="Novidades e melhorias entregues nas releases dos sistemas."
        icon={<Rocket size={24} aria-hidden />}
        actions={
          can('updates.manage') ? (
            <Link className="btn" to="/interno/atualizacoes">
              Gerenciar integração com o Jira
            </Link>
          ) : undefined
        }
      />
      <UpdateList manage={false} />
    </div>
  );
}

export function UpdateViewPage() {
  const { id = '' } = useParams();
  const { data, isLoading } = useQuery({ queryKey: ['update', id], queryFn: () => get<{ update: UpdateItem }>(`/api/updates/${id}`).then((r) => r.update) });
  if (isLoading) return <Spinner />;
  if (!data)
    return (
      <div className="page page-narrow">
        <Empty title="Atualização não encontrada." />
      </div>
    );
  return (
    <div className="page page-narrow">
      <Link to="/atualizacoes" className="small">
        <ArrowLeft size={14} aria-hidden style={{ verticalAlign: 'middle' }} /> Atualizações
      </Link>
      <h1 style={{ marginTop: 8 }}>{data.title}</h1>
      <div className="result-meta" style={{ marginBottom: 16 }}>
        <span className="badge badge-info">Release {data.release}</span>
        {data.system && <span className="badge">{data.system.name}</span>}
        <span>Concluída em {formatDateTime(data.completedAt ?? data.publishedAt)}</span>
        {data.jiraUrl && data.status !== undefined && (
          <a href={data.jiraUrl} target="_blank" rel="noreferrer noopener">
            {data.jiraKey} <ExternalLink size={12} aria-hidden />
          </a>
        )}
      </div>
      <div style={{ whiteSpace: 'pre-wrap' }}>{data.description || 'Sem descrição.'}</div>
    </div>
  );
}

/** Gestão (internos com updates.manage): conteúdo vem do Jira; aqui só se ajusta a exibição. */
export function UpdatesManagePage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const info = useQuery({ queryKey: ['updates-integration'], queryFn: () => get<Integration>('/api/updates/integration') });
  const sync = useMutation({
    mutationFn: () => post<{ found: number; published: number; updated: number; hidden: number; ignored: number }>('/api/updates/sync'),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: ['updates'] });
      toast('success', `Sincronizado: ${r.found} encontradas, ${r.published} publicadas, ${r.updated} atualizadas.`);
    },
    onError: (e) => toast('error', errorMessage(e)),
  });
  const i = info.data;
  return (
    <div className="page">
      <PageHeader
        title="Atualizações (Jira)"
        subtitle="Tarefas concluídas com o campo de release preenchido entram aqui automaticamente."
        icon={<Rocket size={24} aria-hidden />}
        actions={
          <Button onClick={() => sync.mutate()} loading={sync.isPending} disabled={!i?.apiConfigured}>
            <RefreshCw size={16} aria-hidden /> Sincronizar agora
          </Button>
        }
      />
      {i && (
        <div className="card card-body" style={{ marginBottom: 16 }}>
          <strong>Integração</strong>
          <ul className="small">
            <li>Webhook: {i.webhookConfigured ? <>ativo em <code>{i.webhookPath}</code></> : 'não configurado (defina JIRA_WEBHOOK_SECRET)'}</li>
            <li>Consulta à API do Jira: {i.apiConfigured ? `configurada (${i.baseUrl})` : 'não configurada'}</li>
            <li>Campo de release: <code>{i.releaseField}</code> · Campo de público alvo: <code>{i.audienceField}</code></li>
            <li>Sincronização automática: {i.autoSyncMinutes > 0 ? `a cada ${i.autoSyncMinutes} min` : 'desativada'}</li>
          </ul>
          {!i.webhookConfigured && !i.apiConfigured && <Alert kind="info">Sem Jira configurado, nenhuma atualização nova será recebida. Veja docs/VARIAVEIS_DE_AMBIENTE.md.</Alert>}
        </div>
      )}
      <UpdateList manage />
    </div>
  );
}
