import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bot, ChevronRight, Clock, FolderOpen, Megaphone, Search, Ticket, TrendingUp, Building } from 'lucide-react';
import { ANNOUNCEMENT_CATEGORY_LABELS, type AnnouncementCategory } from '@shared/domain';
import { get } from '../lib/api';
import { formatDate } from '../lib/format';
import { useAuth } from '../context/AuthContext';
import { openChat } from '../components/ChatWidget';
import { Empty, Spinner } from '../components/ui';

interface HomeData {
  categories: Array<{ id: string; name: string; slug: string; description: string | null; articleCount: number }>;
  recent: Array<{ id: string; slug: string; title: string; summary: string; updatedAt: string; category: string | null }>;
  popular: Array<{ id: string; slug: string; title: string; summary: string; updatedAt: string; category: string | null }>;
  announcements: Array<{ id: string; title: string; category: AnnouncementCategory; publishedAt: string; system: string | null }>;
}

export function SearchBox({ initial = '', autoFocus }: { initial?: string; autoFocus?: boolean }) {
  const [q, setQ] = useState(initial);
  const navigate = useNavigate();
  return (
    <form
      role="search"
      className="search-box"
      onSubmit={(e) => {
        e.preventDefault();
        navigate(`/busca?q=${encodeURIComponent(q.trim())}`);
      }}
    >
      <label htmlFor="home-search" className="sr-only">
        Pesquisar na Base de Conhecimento
      </label>
      <input
        id="home-search"
        type="search"
        placeholder="Ex.: erro ao exportar relatório"
        value={q}
        autoFocus={autoFocus}
        onChange={(e) => setQ(e.target.value)}
        autoComplete="off"
      />
      <button type="submit">
        <Search size={18} aria-hidden /> <span>Pesquisar</span>
      </button>
    </form>
  );
}

export function HomePage() {
  const { user, isInternal, config } = useAuth();
  const { data, isLoading } = useQuery({ queryKey: ['home', user?.id], queryFn: () => get<HomeData>('/api/home') });

  return (
    <>
      <section className="hero">
        <div className="hero-inner">
          <h1>Como podemos ajudar?</h1>
          <p>Pesquise artigos, procedimentos, tutoriais e atualizações dos sistemas.</p>
          <SearchBox autoFocus />
          <div className="hero-actions">
            <button type="button" className="btn" onClick={openChat}>
              <Bot size={18} aria-hidden /> Perguntar ao assistente
            </button>
            <Link className="btn" to="/tickets/novo">
              <Ticket size={18} aria-hidden /> Abrir ticket
            </Link>
            {isInternal && (
              <Link className="btn" to="/interno">
                <Building size={18} aria-hidden /> Ambiente interno
              </Link>
            )}
          </div>
        </div>
      </section>
      <div className="page">
        {!config?.anonymousAccess && !user ? (
          <Empty title="Entre para acessar a Base de Conhecimento">
            <Link to="/entrar" className="btn btn-primary" style={{ marginTop: 8 }}>
              Entrar
            </Link>
          </Empty>
        ) : isLoading || !data ? (
          <Spinner />
        ) : (
          <div className="stack" style={{ gap: 28 }}>
            <section aria-labelledby="cat-title">
              <h2 id="cat-title" className="row" style={{ gap: 8 }}>
                <FolderOpen size={20} aria-hidden /> Categorias
              </h2>
              {data.categories.length === 0 ? (
                <Empty title="Nenhuma categoria cadastrada." />
              ) : (
                <div className="grid grid-3">
                  {data.categories.map((c) => (
                    <Link key={c.id} to={`/busca?category=${c.id}`} className="card category-card">
                      <span className="category-icon" aria-hidden>
                        <FolderOpen size={20} />
                      </span>
                      <span>
                        <strong style={{ display: 'block' }}>{c.name}</strong>
                        {c.description && <span className="small muted">{c.description}</span>}
                        <span className="tiny muted" style={{ display: 'block', marginTop: 4 }}>
                          {c.articleCount} {c.articleCount === 1 ? 'artigo' : 'artigos'}
                        </span>
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </section>

            <div className="grid grid-2">
              <section className="card" aria-labelledby="recent-title">
                <div className="card-header">
                  <h2 id="recent-title" className="row" style={{ gap: 8 }}>
                    <Clock size={18} aria-hidden /> Atualizados recentemente
                  </h2>
                </div>
                {data.recent.length === 0 ? (
                  <Empty title="Nenhum artigo publicado ainda." />
                ) : (
                  <ul className="article-list">
                    {data.recent.map((a) => (
                      <li key={a.id}>
                        <Link to={`/artigos/${a.slug}`}>{a.title}</Link>
                        <div className="tiny muted">
                          {a.category ?? 'Sem categoria'} · atualizado em {formatDate(a.updatedAt)}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section className="card" aria-labelledby="pop-title">
                <div className="card-header">
                  <h2 id="pop-title" className="row" style={{ gap: 8 }}>
                    <TrendingUp size={18} aria-hidden /> Mais acessados
                  </h2>
                </div>
                {data.popular.length === 0 ? (
                  <Empty title="Ainda não há dados de acesso suficientes." />
                ) : (
                  <ul className="article-list">
                    {data.popular.map((a) => (
                      <li key={a.id}>
                        <Link to={`/artigos/${a.slug}`}>{a.title}</Link>
                        <div className="tiny muted">{a.category ?? 'Sem categoria'}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <section className="card" aria-labelledby="ann-title">
              <div className="card-header">
                <h2 id="ann-title" className="row" style={{ gap: 8 }}>
                  <Megaphone size={18} aria-hidden /> Atualizações e comunicados
                </h2>
                <Link to="/comunicados" className="small">
                  Ver todos <ChevronRight size={14} aria-hidden style={{ verticalAlign: 'middle' }} />
                </Link>
              </div>
              {data.announcements.length === 0 ? (
                <Empty title="Nenhum comunicado publicado." />
              ) : (
                <ul className="article-list">
                  {data.announcements.map((n) => (
                    <li key={n.id}>
                      <Link to={`/comunicados/${n.id}`}>{n.title}</Link>
                      <div className="tiny muted">
                        {ANNOUNCEMENT_CATEGORY_LABELS[n.category]} {n.system && `· ${n.system}`} · {formatDate(n.publishedAt)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </>
  );
}
