import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Eye, EyeOff, Megaphone, Plus, Save } from 'lucide-react';
import { ANNOUNCEMENT_CATEGORIES, ANNOUNCEMENT_CATEGORY_LABELS, VISIBILITY_LABELS, type AnnouncementCategory } from '@shared/domain';
import { errorMessage, fieldErrors, get, post, put, qs } from '../lib/api';
import { formatDate, formatDateTime } from '../lib/format';
import type { Taxonomy } from '../lib/types';
import { useAuth } from '../context/AuthContext';
import { PageHeader } from '../components/Layout';
import { RichContent } from '../components/content/RichContent';
import { RichEditor } from '../components/editor/RichEditor';
import { Alert, Button, Empty, Field, Pagination, Spinner, StatusBadge, useToast } from '../components/ui';

interface AnnouncementItem {
  id: string;
  title: string;
  category: AnnouncementCategory;
  status: string;
  visibility: 'internal' | 'external';
  publishedAt: string | null;
  createdAt: string;
  excerpt: string;
  systems: string[];
  author: string;
}
interface Announcement {
  id: string;
  title: string;
  contentHtml: string;
  category: AnnouncementCategory;
  systems: Array<{ id: string; name: string }>;
  visibility: 'internal' | 'external';
  status: 'draft' | 'published';
  author: string;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  relatedArticles: Array<{ id: string; slug: string; title: string }>;
}

function AnnouncementList({ manage }: { manage: boolean }) {
  const [f, setF] = useState({ q: '', system: '', category: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const taxonomy = useQuery({ queryKey: ['taxonomy'], queryFn: () => get<Taxonomy>('/api/taxonomy') });
  const list = useQuery({
    queryKey: ['announcements', manage, f, page],
    queryFn: () => get<{ total: number; items: AnnouncementItem[] }>(`/api/announcements${qs({ ...f, page, pageSize: 15, manage: manage ? '1' : undefined })}`),
  });
  const set = (k: keyof typeof f, v: string) => {
    setF((x) => ({ ...x, [k]: v }));
    setPage(1);
  };
  return (
    <>
      <div className="card card-body" style={{ marginBottom: 16 }}>
        <div className="grid grid-4">
          <Field label="Pesquisar" htmlFor="an-q">
            <input id="an-q" className="input" value={f.q} onChange={(e) => set('q', e.target.value)} />
          </Field>
          <Field label="Sistema" htmlFor="an-sys">
            <select id="an-sys" className="select" value={f.system} onChange={(e) => set('system', e.target.value)}>
              <option value="">Todos</option>
              {taxonomy.data?.systems.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Categoria" htmlFor="an-cat">
            <select id="an-cat" className="select" value={f.category} onChange={(e) => set('category', e.target.value)}>
              <option value="">Todas</option>
              {ANNOUNCEMENT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {ANNOUNCEMENT_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="A partir de" htmlFor="an-from">
            <input id="an-from" type="date" className="input" value={f.from} onChange={(e) => set('from', e.target.value)} />
          </Field>
        </div>
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : !list.data?.items.length ? (
        <div className="card">
          <Empty title="Nenhum comunicado encontrado." />
        </div>
      ) : (
        <div className="card">
          {list.data.items.map((n) => (
            <article key={n.id} className="result">
              <h3>
                <Link to={manage ? `/interno/comunicados/${n.id}` : `/comunicados/${n.id}`}>{n.title}</Link>
              </h3>
              <div className="result-meta">
                <span className="badge badge-info">{ANNOUNCEMENT_CATEGORY_LABELS[n.category]}</span>
                {n.systems.map((s) => <span key={s} className="badge">{s}</span>)}
                {manage && <StatusBadge status={n.status === 'published' ? 'published' : 'draft'} />}
                {manage && <span className={`badge ${n.visibility === 'external' ? 'badge-success' : 'badge-info'}`}>{VISIBILITY_LABELS[n.visibility]}</span>}
                <span>{n.publishedAt ? formatDate(n.publishedAt) : `Criado em ${formatDate(n.createdAt)}`}</span>
              </div>
              <p className="snippet">{n.excerpt}</p>
            </article>
          ))}
        </div>
      )}
      {list.data && <Pagination page={page} pageSize={15} total={list.data.total} onChange={setPage} />}
    </>
  );
}

export function AnnouncementsPage() {
  return (
    <div className="page">
      <PageHeader
        title="Comunicados"
        subtitle="Novidades, alterações de funcionalidade, manutenções e avisos vinculados aos sistemas."
        icon={<Megaphone size={24} aria-hidden />}
      />
      <AnnouncementList manage={false} />
    </div>
  );
}

export function AnnouncementViewPage() {
  const { id = '' } = useParams();
  const { data, isLoading } = useQuery({ queryKey: ['announcement', id], queryFn: () => get<{ announcement: Announcement }>(`/api/announcements/${id}`).then((r) => r.announcement) });
  if (isLoading) return <Spinner />;
  if (!data)
    return (
      <div className="page page-narrow">
        <Empty title="Comunicado não encontrado." />
      </div>
    );
  return (
    <div className="page page-narrow">
      <Link to="/comunicados" className="small">
        <ArrowLeft size={14} aria-hidden style={{ verticalAlign: 'middle' }} /> Comunicados
      </Link>
      <h1 style={{ marginTop: 8 }}>{data.title}</h1>
      <div className="result-meta" style={{ marginBottom: 16 }}>
        <span className="badge badge-info">{ANNOUNCEMENT_CATEGORY_LABELS[data.category]}</span>
        {data.systems.map((s) => <span key={s.id} className="badge">{s.name}</span>)}
        <span>
          Publicado em {formatDateTime(data.publishedAt)} por {data.author}
        </span>
      </div>
      <RichContent html={data.contentHtml} />
      {data.relatedArticles.length > 0 && (
        <section className="card card-body" style={{ marginTop: 24 }}>
          <strong>Artigos relacionados</strong>
          <ul>
            {data.relatedArticles.map((a) => (
              <li key={a.id}>
                <Link to={`/artigos/${a.slug}`}>{a.title}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function AnnouncementsManagePage() {
  return (
    <div className="page">
      <PageHeader
        title="Comunicados"
        icon={<Megaphone size={24} aria-hidden />}
        actions={
          <Link className="btn btn-cta" to="/interno/comunicados/novo">
            <Plus size={16} aria-hidden /> Novo comunicado
          </Link>
        }
      />
      <AnnouncementList manage />
    </div>
  );
}

export function AnnouncementEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const taxonomy = useQuery({ queryKey: ['taxonomy'], queryFn: () => get<Taxonomy>('/api/taxonomy') });
  const existing = useQuery({ queryKey: ['announcement', id], queryFn: () => get<{ announcement: Announcement }>(`/api/announcements/${id}`).then((r) => r.announcement), enabled: !!id });
  const [form, setForm] = useState<null | { title: string; contentHtml: string; category: AnnouncementCategory; systemIds: string[]; visibility: 'internal' | 'external'; relatedArticleIds: string[] }>(null);
  const [articleQ, setArticleQ] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const picker = useQuery({
    queryKey: ['announcement-article-search', articleQ],
    queryFn: () => get<{ results: Array<{ id: string; title: string }> }>(`/api/search${qs({ q: articleQ, pageSize: 8 })}`),
    enabled: articleQ.length >= 2,
  });
  const [relatedTitles, setRelatedTitles] = useState<Record<string, string>>({});

  if (id && existing.isLoading) return <Spinner />;
  const a = existing.data;
  const current =
    form ??
    (a
      ? { title: a.title, contentHtml: a.contentHtml, category: a.category, systemIds: a.systems.map((x) => x.id), visibility: a.visibility, relatedArticleIds: a.relatedArticles.map((r) => r.id) }
      : { title: '', contentHtml: '', category: 'novidade' as AnnouncementCategory, systemIds: [] as string[], visibility: 'internal' as const, relatedArticleIds: [] });
  const titles: Record<string, string> = { ...Object.fromEntries((a?.relatedArticles ?? []).map((r) => [r.id, r.title])), ...relatedTitles };
  const update = (patch: Partial<typeof current>) => setForm({ ...current, ...patch });

  const save = async (publish?: boolean) => {
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      const body = { ...current };
      const res = id ? await put<{ announcement: Announcement }>(`/api/announcements/${id}`, body) : await post<{ announcement: Announcement }>('/api/announcements', body);
      if (publish !== undefined) await post(`/api/announcements/${res.announcement.id}/${publish ? 'publish' : 'unpublish'}`);
      await queryClient.invalidateQueries({ queryKey: ['announcements'] });
      await queryClient.invalidateQueries({ queryKey: ['announcement', res.announcement.id] });
      toast('success', publish ? 'Comunicado publicado.' : publish === false ? 'Comunicado despublicado.' : 'Comunicado salvo.');
      setForm(null);
      if (!id) navigate(`/interno/comunicados/${res.announcement.id}`, { replace: true });
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <PageHeader
        title={id ? 'Editar comunicado' : 'Novo comunicado'}
        subtitle={a && (
          <span className="row" style={{ gap: 8 }}>
            <StatusBadge status={a.status === 'published' ? 'published' : 'draft'} /> {a.publishedAt && `Publicado em ${formatDateTime(a.publishedAt)}`}
          </span>
        )}
        actions={
          <Link className="btn" to="/interno/comunicados">
            <ArrowLeft size={16} aria-hidden /> Voltar
          </Link>
        }
      />
      <div className="stack">
        <div className="grid grid-2">
          <Field label="Título" htmlFor="ae-title" required error={errors.title}>
            <input id="ae-title" className="input" value={current.title} onChange={(e) => update({ title: e.target.value })} />
          </Field>
          <Field label="Visibilidade" required error={errors.visibility} hint="Externo: clientes e visitantes também veem. Interno: somente a equipe.">
            <div className="segmented" role="group" aria-label="Visibilidade">
              {(['internal', 'external'] as const).map((v) => (
                <button key={v} type="button" aria-pressed={current.visibility === v} onClick={() => update({ visibility: v })}>
                  {VISIBILITY_LABELS[v]}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Categoria" htmlFor="ae-cat" required>
            <select id="ae-cat" className="select" value={current.category} onChange={(e) => update({ category: e.target.value as AnnouncementCategory })}>
              {ANNOUNCEMENT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {ANNOUNCEMENT_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Plataformas vinculadas" required error={errors.systemIds}>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }} role="group" aria-label="Plataformas vinculadas">
            {taxonomy.data?.systems.map((s) => (
              <label key={s.id} className="row" style={{ gap: 6 }}>
                <input
                  type="checkbox"
                  checked={current.systemIds.includes(s.id)}
                  onChange={(e) => update({ systemIds: e.target.checked ? [...current.systemIds, s.id] : current.systemIds.filter((x) => x !== s.id) })}
                />
                {s.name}
              </label>
            ))}
          </div>
        </Field>
        <div>
          <span className="label">Aviso (imagens e vídeos opcionais)</span>
          <div style={{ marginTop: 6 }}>
            <RichEditor key={a?.id ?? 'new'} initialHtml={current.contentHtml} onChange={(html) => update({ contentHtml: html })} placeholder="Descreva a atualização ou comunicado…" />
          </div>
        </div>
        <Field label="Artigos relacionados" htmlFor="ae-art">
          <div className="stack" style={{ gap: 6 }}>
            {current.relatedArticleIds.map((aid) => (
              <span key={aid} className="chip" style={{ alignSelf: 'flex-start' }}>
                {titles[aid] ?? aid}
                <button type="button" aria-label="Remover" onClick={() => update({ relatedArticleIds: current.relatedArticleIds.filter((x) => x !== aid) })}>
                  ×
                </button>
              </span>
            ))}
            <input id="ae-art" className="input" placeholder="Pesquisar artigo…" value={articleQ} onChange={(e) => setArticleQ(e.target.value)} />
            {picker.data?.results
              .filter((r) => !current.relatedArticleIds.includes(r.id))
              .map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className="btn btn-sm"
                  style={{ justifyContent: 'flex-start' }}
                  onClick={() => {
                    setRelatedTitles((t) => ({ ...t, [r.id]: r.title }));
                    update({ relatedArticleIds: [...current.relatedArticleIds, r.id] });
                    setArticleQ('');
                  }}
                >
                  + {r.title}
                </button>
              ))}
          </div>
        </Field>
        {error && <Alert kind="danger">{error}</Alert>}
        <div className="btn-group">
          <Button onClick={() => save()} loading={busy}>
            <Save size={16} aria-hidden /> Salvar
          </Button>
          {a?.status !== 'published' ? (
            <Button variant="primary" onClick={() => save(true)} loading={busy}>
              <Eye size={16} aria-hidden /> Salvar e publicar
            </Button>
          ) : (
            <Button onClick={() => save(false)} loading={busy}>
              <EyeOff size={16} aria-hidden /> Despublicar
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
