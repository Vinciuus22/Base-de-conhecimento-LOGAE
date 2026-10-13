import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import { formatDate } from '../lib/format';
import { useAuth } from '../context/AuthContext';
import { Empty, Spinner } from '../components/ui';
import { SearchResults } from './Search';

interface ArticleItem { id: string; slug: string; title: string; summary: string; updatedAt: string; category: string | null }
interface HomeData {
  categories: Array<{ id: string; name: string; slug: string; description: string | null; articleCount: number }>;
  recent: ArticleItem[];
  popular: ArticleItem[];
  mine: ArticleItem[];
  systems: Array<{ id: string; name: string; slug: string }>;
}

const SEARCH_KEYS = ['q', 'category', 'system', 'tag', 'visibility', 'from', 'to'];

function ArticleList({ title, subtitle, items, empty }: { title: string; subtitle: string; items: ArticleItem[]; empty: string }) {
  return (
    <section className="card" aria-label={title}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>{title}</h2>
        <span className="small muted" style={{ fontSize: 13 }}>{subtitle}</span>
      </div>
      {items.length === 0 ? (
        <p className="small muted" style={{ padding: '16px 20px', margin: 0 }}>{empty}</p>
      ) : (
        <ul className="article-list">
          {items.map((a) => (
            <li key={a.id}>
              <Link to={`/artigos/${a.slug}`}>{a.title}</Link>
              <div className="tiny muted">{a.category ?? 'Sem categoria'} · atualizado em {formatDate(a.updatedAt)}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function HomePage() {
  const { user, isInternal, config } = useAuth();
  const [params, setParams] = useSearchParams();
  const urlQ = params.get('q') ?? '';
  const [text, setText] = useState(urlQ);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { data, isLoading } = useQuery({ queryKey: ['home', user?.id], queryFn: () => get<HomeData>('/api/home') });
  const searching = SEARCH_KEYS.some((k) => params.get(k));

  // mantém o campo em sincronia quando a URL muda por outro caminho (ex.: "Limpar", sugestões)
  useEffect(() => setText(urlQ), [urlQ]);

  const setParam = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    next.delete('page');
    setParams(next, { replace: true });
  };
  const onType = (v: string) => {
    setText(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setParam({ q: v.trim() }), 300);
  };
  const activeSystem = params.get('system') ?? '';

  return (
    <>
      <section className="hero">
        <div className="hero-inner">
          <h1>Como podemos ajudar?</h1>
          <p>Pesquise artigos, procedimentos e tutoriais da base de conhecimento.</p>
          <form
            role="search"
            className="hero-search"
            onSubmit={(e) => {
              e.preventDefault();
              clearTimeout(timer.current);
              setParam({ q: text.trim() });
            }}
          >
            <label htmlFor="home-search" className="sr-only">
              Pesquisar na Base de Conhecimento
            </label>
            <input id="home-search" type="search" placeholder="Pesquise por título, palavra-chave, categoria ou sistema" value={text} onChange={(e) => onType(e.target.value)} autoComplete="off" />
            <button type="button" className="hero-clear" onClick={() => { clearTimeout(timer.current); setText(''); setParams({}, { replace: true }); }}>
              Limpar
            </button>
            <button type="submit" className="sr-only">Pesquisar</button>
          </form>
          {data && data.systems.length > 0 && (
            <div className="hero-chips" role="group" aria-label="Filtrar por sistema">
              {data.systems.map((s) => (
                <button key={s.id} type="button" className="hero-chip" aria-pressed={activeSystem === s.id} onClick={() => setParam({ system: activeSystem === s.id ? '' : s.id })}>
                  {s.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </section>
      <div className="page" style={{ maxWidth: 1180, padding: '32px 20px 56px' }}>
        {!config?.anonymousAccess && !user ? (
          <Empty title="Entre para acessar a Base de Conhecimento">
            <Link to="/entrar" className="btn btn-primary" style={{ marginTop: 8 }}>
              Entrar
            </Link>
          </Empty>
        ) : searching ? (
          <SearchResults />
        ) : isLoading || !data ? (
          <Spinner />
        ) : (
          <div className="stack" style={{ gap: 30 }}>
            <section aria-labelledby="cat-title">
              <h2 id="cat-title">Artigos por categoria</h2>
              {data.categories.length === 0 ? (
                <Empty title="Nenhuma categoria cadastrada." />
              ) : (
                <div className="category-grid">
                  {data.categories.map((c) => (
                    <button key={c.id} type="button" className="card category-card" onClick={() => setParam({ category: c.id })}>
                      <strong style={{ display: 'block', fontSize: 16 }}>{c.name}</strong>
                      {c.description && <span className="small muted" style={{ display: 'block', marginTop: 4 }}>{c.description}</span>}
                      <span style={{ display: 'block', marginTop: 8, fontSize: 12, fontWeight: 600, color: 'var(--mint)' }}>
                        {c.articleCount} {c.articleCount === 1 ? 'artigo' : 'artigos'}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
              {isInternal ? (
                <>
                  <ArticleList title="Mais acessados" subtitle="Consolidado de toda a base" items={data.popular} empty="Ainda não há dados de acesso suficientes." />
                  <ArticleList title="Atualizados recentemente" subtitle="Últimas revisões publicadas" items={data.recent} empty="Nenhum artigo publicado ainda." />
                </>
              ) : (
                <>
                  <ArticleList title="Mais acessados por todos os clientes" subtitle="Ranking geral dos últimos 30 dias" items={data.popular} empty="Ainda não há dados de acesso suficientes." />
                  {user ? (
                    <ArticleList title="Mais acessados por você" subtitle="Seu histórico de leitura" items={data.mine} empty="Você ainda não leu nenhum artigo." />
                  ) : (
                    <ArticleList title="Atualizados recentemente" subtitle="Últimas revisões publicadas" items={data.recent} empty="Nenhum artigo publicado ainda." />
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
