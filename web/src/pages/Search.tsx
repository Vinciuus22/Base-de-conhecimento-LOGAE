import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bot, Lightbulb, SearchX, Sparkles, Ticket } from 'lucide-react';
import { get, qs } from '../lib/api';
import { formatDate } from '../lib/format';
import type { Taxonomy } from '../lib/types';
import { useAuth } from '../context/AuthContext';
import { SearchBox } from './Home';
import { Empty, Field, Highlighted, HighlightTerms, Pagination, Spinner, VisibilityBadge } from '../components/ui';
import { openChat } from '../components/ChatWidget';

interface SearchResponse {
  results: Array<{
    id: string;
    slug: string;
    title: string;
    summary: string;
    updatedAt: string;
    visibility: string;
    category: { id: string; name: string } | null;
    system: { id: string; name: string } | null;
    tags: string[];
    headline: string;
    matchType: 'text' | 'fuzzy' | 'semantic';
  }>;
  total: number;
  suggestions: string[];
  expandedTerms: string[];
  terms: string[];
  semantic: boolean;
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const { isInternal, can } = useAuth();
  const q = params.get('q') ?? '';
  const page = Number(params.get('page') ?? 1);
  const filters = {
    category: params.get('category') ?? '',
    system: params.get('system') ?? '',
    tag: params.get('tag') ?? '',
    visibility: params.get('visibility') ?? '',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
  };
  const taxonomy = useQuery({ queryKey: ['taxonomy'], queryFn: () => get<Taxonomy>('/api/taxonomy'), staleTime: 60_000 });
  const search = useQuery({
    queryKey: ['search', q, page, filters],
    queryFn: () => get<SearchResponse>(`/api/search${qs({ q, page, pageSize: 10, ...filters })}`),
    enabled: !!q || Object.values(filters).some(Boolean),
  });

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('page');
    setParams(next);
  };

  const data = search.data;
  return (
    <div className="page">
      <div style={{ maxWidth: 820, marginBottom: 20 }}>
        <SearchBox key={q} initial={q} />
      </div>
      <div className="search-layout">
        <aside className="card card-body stack" aria-label="Filtros">
          <strong>Filtrar resultados</strong>
          <Field label="Categoria" htmlFor="f-cat">
            <select id="f-cat" className="select" value={filters.category} onChange={(e) => setFilter('category', e.target.value)}>
              <option value="">Todas</option>
              {taxonomy.data?.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Sistema" htmlFor="f-sys">
            <select id="f-sys" className="select" value={filters.system} onChange={(e) => setFilter('system', e.target.value)}>
              <option value="">Todos</option>
              {taxonomy.data?.systems.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tag" htmlFor="f-tag">
            <select id="f-tag" className="select" value={filters.tag} onChange={(e) => setFilter('tag', e.target.value)}>
              <option value="">Todas</option>
              {taxonomy.data?.tags.map((t) => (
                <option key={t.id} value={t.slug}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
          {isInternal && can('articles.view_internal') && (
            <Field label="Visibilidade" htmlFor="f-vis">
              <select id="f-vis" className="select" value={filters.visibility} onChange={(e) => setFilter('visibility', e.target.value)}>
                <option value="">Interna e externa</option>
                <option value="internal">Somente internos</option>
                <option value="external">Somente externos</option>
              </select>
            </Field>
          )}
          <Field label="Atualizado a partir de" htmlFor="f-from">
            <input id="f-from" type="date" className="input" value={filters.from} onChange={(e) => setFilter('from', e.target.value)} />
          </Field>
          <Field label="Atualizado até" htmlFor="f-to">
            <input id="f-to" type="date" className="input" value={filters.to} onChange={(e) => setFilter('to', e.target.value)} />
          </Field>
          {Object.values(filters).some(Boolean) && (
            <button type="button" className="btn btn-sm" onClick={() => setParams(q ? { q } : {})}>
              Limpar filtros
            </button>
          )}
        </aside>

        <section aria-live="polite">
          {!q && !Object.values(filters).some(Boolean) ? (
            <Empty title="Digite um termo para pesquisar">Pesquise por título, conteúdo, palavras-chave, tags, categoria ou sistema.</Empty>
          ) : search.isLoading ? (
            <Spinner label="Pesquisando…" />
          ) : search.isError ? (
            <div className="alert alert-danger">Não foi possível realizar a pesquisa. Tente novamente.</div>
          ) : data && (
            <>
              <p className="muted small" style={{ marginTop: 0 }}>
                {data.total === 0 ? 'Nenhum resultado' : `${data.total} ${data.total === 1 ? 'resultado' : 'resultados'}`}
                {q && (
                  <>
                    {' '}
                    para <strong>“{q}”</strong>
                  </>
                )}
                {data.expandedTerms.length > 0 && <> · incluindo termos relacionados: {data.expandedTerms.join(', ')}</>}
              </p>
              {data.suggestions.length > 0 && (
                <div className="alert alert-info" style={{ marginBottom: 16 }}>
                  <Lightbulb size={18} aria-hidden />
                  <div>
                    Você quis dizer:{' '}
                    {data.suggestions.map((s, i) => (
                      <span key={s}>
                        {i > 0 && ', '}
                        <Link to={`/busca?q=${encodeURIComponent(s)}`}>
                          <strong>{s}</strong>
                        </Link>
                      </span>
                    ))}
                    ?
                  </div>
                </div>
              )}
              {data.total === 0 ? (
                <div className="card card-body">
                  <Empty title="Não encontramos artigos para essa pesquisa." icon={<SearchX size={36} aria-hidden />}>
                    <p>Tente outras palavras, remova filtros ou pergunte ao assistente.</p>
                    <div className="btn-group" style={{ justifyContent: 'center' }}>
                      <button type="button" className="btn" onClick={openChat}>
                        <Bot size={16} aria-hidden /> Perguntar ao assistente
                      </button>
                      <Link className="btn btn-primary" to="/tickets/novo" state={{ draft: { title: q, description: '' } }}>
                        <Ticket size={16} aria-hidden /> Abrir ticket
                      </Link>
                    </div>
                  </Empty>
                </div>
              ) : (
                <div className="card">
                  {data.results.map((r) => (
                    <article key={r.id} className="result">
                      <h3>
                        <Link to={`/artigos/${r.slug}`}>
                          <HighlightTerms text={r.title} terms={data.terms} />
                        </Link>
                      </h3>
                      <div className="result-meta">
                        {r.category && <span className="badge">{r.category.name}</span>}
                        {r.system && <span className="badge">{r.system.name}</span>}
                        {isInternal && <VisibilityBadge visibility={r.visibility} />}
                        {r.matchType === 'semantic' && (
                          <span className="badge badge-purple" title="Encontrado por similaridade de significado">
                            <Sparkles size={12} aria-hidden /> Relacionado
                          </span>
                        )}
                        <span>Atualizado em {formatDate(r.updatedAt)}</span>
                      </div>
                      <p className="snippet">
                        <HighlightTerms text={r.summary} terms={data.terms} />
                      </p>
                      {r.headline && r.matchType !== 'semantic' && (
                        <p className="snippet small">
                          … <Highlighted text={r.headline.replace(/\n+/g, ' ')} /> …
                        </p>
                      )}
                    </article>
                  ))}
                </div>
              )}
              <Pagination page={page} pageSize={10} total={data.total} onChange={(p) => setFilter('page', String(p))} />
            </>
          )}
        </section>
      </div>
    </div>
  );
}
