import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileStack, Headset, Lock, Megaphone, Newspaper, Plus, ShieldCheck, Unlock, LayoutDashboard } from 'lucide-react';
import { ARTICLE_STATUSES, ARTICLE_STATUS_LABELS } from '@shared/domain';
import { errorMessage, get, post, qs } from '../../lib/api';
import { formatDateTime, relativeTime } from '../../lib/format';
import type { Taxonomy } from '../../lib/types';
import { useAuth } from '../../context/AuthContext';
import { PageHeader } from '../../components/Layout';
import { ConfirmDialog, Empty, Field, Pagination, Spinner, StatusBadge, VisibilityBadge, useToast } from '../../components/ui';

export function DashboardPage() {
  const { user, can } = useAuth();
  const mine = useQuery({
    queryKey: ['articles', 'mine-dashboard'],
    queryFn: () => get<{ items: Array<{ id: string; slug: string; title: string; status: string; updatedAt: string }> }>('/api/articles?author=me&pageSize=5'),
    enabled: can('articles.create') || can('articles.edit'),
  });
  const tickets = useQuery({
    queryKey: ['support-tickets', 'dashboard'],
    queryFn: () => get<{ counts: Record<string, number> }>('/api/support/tickets?pageSize=1&status=active'),
    enabled: can('tickets.support') || can('tickets.manage'),
  });
  const cards = [
    { show: can('articles.create') || can('articles.edit_others'), to: '/interno/artigos/novo', icon: <Plus size={20} />, title: 'Novo artigo', text: 'Criar um artigo ou procedimento' },
    { show: true, to: '/interno/artigos', icon: <Newspaper size={20} />, title: 'Artigos', text: 'Gerenciar artigos e rascunhos' },
    { show: can('tickets.support') || can('tickets.manage'), to: '/interno/tickets', icon: <Headset size={20} />, title: 'Atendimento', text: 'Fila de tickets autorizados' },
    { show: can('announcements.manage'), to: '/interno/comunicados', icon: <Megaphone size={20} />, title: 'Comunicados', text: 'Atualizações e avisos' },
    { show: can('documents.manage'), to: '/interno/documentos', icon: <FileStack size={20} />, title: 'Documentos', text: 'Importar PDF e Word' },
    { show: can('audit.view'), to: '/interno/auditoria', icon: <ShieldCheck size={20} />, title: 'Auditoria', text: 'Registros de operações' },
  ].filter((c) => c.show);
  const counts = tickets.data?.counts ?? {};
  return (
    <div className="page">
      <PageHeader title={`Olá, ${user?.name.split(' ')[0]}`} subtitle="Ambiente interno da Base de Conhecimento." icon={<LayoutDashboard size={24} aria-hidden />} />
      <div className="grid grid-3">
        {cards.map((c) => (
          <Link key={c.to} to={c.to} className="card category-card">
            <span className="category-icon" aria-hidden>
              {c.icon}
            </span>
            <span>
              <strong style={{ display: 'block' }}>{c.title}</strong>
              <span className="small muted">{c.text}</span>
            </span>
          </Link>
        ))}
      </div>
      <div className="grid grid-2" style={{ marginTop: 20 }}>
        {(can('tickets.support') || can('tickets.manage')) && (
          <section className="card card-body">
            <h2 style={{ fontSize: '1.05rem' }}>Tickets em andamento</h2>
            <div className="row">
              {['open', 'triage', 'in_progress', 'waiting_user', 'waiting_technical'].map((s) => (
                <Link key={s} to={`/interno/tickets?status=${s}`} className="badge" style={{ fontSize: '0.85rem', padding: '6px 10px' }}>
                  <StatusBadge status={s} /> {counts[s] ?? 0}
                </Link>
              ))}
            </div>
          </section>
        )}
        {mine.data && (
          <section className="card">
            <div className="card-header">
              <h2>Meus artigos recentes</h2>
            </div>
            {mine.data.items.length === 0 ? (
              <Empty title="Você ainda não criou artigos." />
            ) : (
              <ul className="article-list">
                {mine.data.items.map((a) => (
                  <li key={a.id} className="row">
                    <Link to={`/artigos/${a.slug}`} style={{ flex: 1 }}>
                      {a.title}
                    </Link>
                    <StatusBadge status={a.status} />
                    <span className="tiny muted">{relativeTime(a.updatedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

interface ArticleRowItem {
  id: string;
  slug: string;
  title: string;
  status: string;
  visibility: string;
  version: number;
  updatedAt: string;
  category: string | null;
  system: string | null;
  author: string;
  lock: { holder: string; acquiredAt: string } | null;
}

export function ArticlesListPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const f = {
    q: params.get('q') ?? '',
    status: params.get('status') ?? '',
    visibility: params.get('visibility') ?? '',
    category: params.get('category') ?? '',
    system: params.get('system') ?? '',
    author: params.get('author') ?? '',
    page: Number(params.get('page') ?? 1),
  };
  const taxonomy = useQuery({ queryKey: ['taxonomy'], queryFn: () => get<Taxonomy>('/api/taxonomy') });
  const list = useQuery({ queryKey: ['articles', f], queryFn: () => get<{ total: number; items: ArticleRowItem[] }>(`/api/articles${qs({ ...f, pageSize: 20 })}`), refetchInterval: 20_000 });
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
        title="Artigos"
        icon={<Newspaper size={24} aria-hidden />}
        actions={
          can('articles.create') && (
            <Link className="btn btn-primary" to="/interno/artigos/novo">
              <Plus size={16} aria-hidden /> Novo artigo
            </Link>
          )
        }
      />
      <div className="card card-body" style={{ marginBottom: 16 }}>
        <form className="grid grid-4" onSubmit={(e) => (e.preventDefault(), set('q', text.trim()))}>
          <Field label="Título" htmlFor="al-q">
            <input id="al-q" className="input" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => set('q', text.trim())} />
          </Field>
          <Field label="Status" htmlFor="al-status">
            <select id="al-status" className="select" value={f.status} onChange={(e) => set('status', e.target.value)}>
              <option value="">Todos</option>
              {ARTICLE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {ARTICLE_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Visibilidade" htmlFor="al-vis">
            <select id="al-vis" className="select" value={f.visibility} onChange={(e) => set('visibility', e.target.value)}>
              <option value="">Todas</option>
              <option value="internal">Interno</option>
              <option value="external">Externo</option>
            </select>
          </Field>
          <Field label="Categoria" htmlFor="al-cat">
            <select id="al-cat" className="select" value={f.category} onChange={(e) => set('category', e.target.value)}>
              <option value="">Todas</option>
              {taxonomy.data?.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <label className="checkbox small">
            <input type="checkbox" checked={f.author === 'me'} onChange={(e) => set('author', e.target.checked ? 'me' : '')} /> Somente meus artigos
          </label>
        </form>
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : !list.data?.items.length ? (
        <div className="card">
          <Empty title="Nenhum artigo encontrado." />
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Título</th>
                <th>Status</th>
                <th>Visibilidade</th>
                <th>Categoria</th>
                <th>Autor</th>
                <th>Versão</th>
                <th>Atualização</th>
                <th>Edição</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link to={`/artigos/${a.slug}`}>{a.title}</Link>
                  </td>
                  <td>
                    <StatusBadge status={a.status} />
                  </td>
                  <td>
                    <VisibilityBadge visibility={a.visibility} />
                  </td>
                  <td>{a.category ?? '—'}</td>
                  <td>{a.author}</td>
                  <td>v{a.version}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{relativeTime(a.updatedAt)}</td>
                  <td>
                    {a.lock ? (
                      <span className="badge badge-warning" title={`Desde ${formatDateTime(a.lock.acquiredAt)}`}>
                        <Lock size={12} aria-hidden /> {a.lock.holder}
                      </span>
                    ) : (
                      <span className="tiny muted">Disponível</span>
                    )}
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

export function LocksPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [release, setRelease] = useState<{ articleId: string; title: string; holder: string } | null>(null);
  const list = useQuery({
    queryKey: ['locks'],
    queryFn: () =>
      get<{ items: Array<{ articleId: string; title: string; slug: string; holder: { name: string }; acquiredAt: string; renewedAt: string; expiresAt: string; expired: boolean }> }>('/api/locks'),
    refetchInterval: 10_000,
  });
  return (
    <div className="page">
      <PageHeader title="Bloqueios de edição" subtitle="Libere bloqueios abandonados. A sessão antiga não poderá sobrescrever o conteúdo atualizado." icon={<Lock size={24} aria-hidden />} />
      {list.isLoading ? (
        <Spinner />
      ) : !list.data?.items.length ? (
        <div className="card">
          <Empty title="Nenhum artigo em edição no momento." />
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Artigo</th>
                <th>Editando</th>
                <th>Desde</th>
                <th>Última renovação</th>
                <th>Expira</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((l) => (
                <tr key={l.articleId}>
                  <td>
                    <Link to={`/artigos/${l.slug}`}>{l.title}</Link>
                  </td>
                  <td>{l.holder.name}</td>
                  <td>{formatDateTime(l.acquiredAt)}</td>
                  <td>{relativeTime(l.renewedAt)}</td>
                  <td>{l.expired ? <span className="badge badge-danger">Expirado</span> : formatDateTime(l.expiresAt)}</td>
                  <td>
                    <button type="button" className="btn btn-sm" onClick={() => setRelease({ articleId: l.articleId, title: l.title, holder: l.holder.name })}>
                      <Unlock size={14} aria-hidden /> Liberar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {release && (
        <ConfirmDialog
          title="Liberar bloqueio de edição"
          message={
            <>
              O bloqueio de <strong>{release.holder}</strong> no artigo “{release.title}” será liberado. Alterações não salvas dessa sessão não poderão ser gravadas. A operação será registrada na auditoria.
            </>
          }
          requireReason
          reasonLabel="Motivo da liberação"
          confirmLabel="Liberar bloqueio"
          danger
          onCancel={() => setRelease(null)}
          onConfirm={async (reason) => {
            try {
              await post(`/api/locks/${release.articleId}/release`, { reason });
              toast('success', 'Bloqueio liberado.');
              setRelease(null);
              await queryClient.invalidateQueries({ queryKey: ['locks'] });
            } catch (err) {
              throw new Error(errorMessage(err));
            }
          }}
        />
      )}
    </div>
  );
}

export function AuditPage() {
  const [f, setF] = useState({ action: '', entityType: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const list = useQuery({
    queryKey: ['audit', f, page],
    queryFn: () =>
      get<{ total: number; items: Array<{ id: number; action: string; entityType: string | null; entityId: string | null; data: unknown; ip: string | null; createdAt: string; actor: { name: string } | null }> }>(
        `/api/audit${qs({ ...f, page, pageSize: 30 })}`,
      ),
  });
  const set = (k: keyof typeof f, v: string) => {
    setF((x) => ({ ...x, [k]: v }));
    setPage(1);
  };
  return (
    <div className="page">
      <PageHeader title="Auditoria" subtitle="Registros imutáveis das operações relevantes (somente leitura)." icon={<ShieldCheck size={24} aria-hidden />} />
      <div className="card card-body" style={{ marginBottom: 16 }}>
        <div className="grid grid-4">
          <Field label="Ação (prefixo)" htmlFor="au-a" hint="Ex.: article., permission., ticket., auth.">
            <input id="au-a" className="input" value={f.action} onChange={(e) => set('action', e.target.value)} />
          </Field>
          <Field label="Entidade" htmlFor="au-e">
            <select id="au-e" className="select" value={f.entityType} onChange={(e) => set('entityType', e.target.value)}>
              <option value="">Todas</option>
              {['article', 'user', 'ticket', 'document', 'file', 'category', 'system', 'announcement', 'company'].map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </Field>
          <Field label="De" htmlFor="au-f">
            <input id="au-f" type="date" className="input" value={f.from} onChange={(e) => set('from', e.target.value)} />
          </Field>
          <Field label="Até" htmlFor="au-t">
            <input id="au-t" type="date" className="input" value={f.to} onChange={(e) => set('to', e.target.value)} />
          </Field>
        </div>
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Data e hora</th>
                <th>Responsável</th>
                <th>Ação</th>
                <th>Entidade</th>
                <th>IP</th>
                <th>Detalhes</th>
              </tr>
            </thead>
            <tbody>
              {list.data?.items.map((r) => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(r.createdAt)}</td>
                  <td>{r.actor?.name ?? 'Sistema'}</td>
                  <td>
                    <code>{r.action}</code>
                  </td>
                  <td className="small">
                    {r.entityType} {r.entityId && <span className="muted">{r.entityId.slice(0, 8)}…</span>}
                  </td>
                  <td className="small">{r.ip ?? '—'}</td>
                  <td>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                      {open === r.id ? 'Ocultar' : 'Ver'}
                    </button>
                    {open === r.id && <pre className="diff tiny" style={{ maxWidth: 420 }}>{JSON.stringify(r.data, null, 2)}</pre>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data && <Pagination page={page} pageSize={30} total={list.data.total} onChange={setPage} />}
    </div>
  );
}
