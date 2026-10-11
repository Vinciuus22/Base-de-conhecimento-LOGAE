import { useCallback, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ArrowLeft, Bot, Eye, EyeOff, History, Pencil, Send, Ticket } from 'lucide-react';
import { ApiError, get, post, errorMessage } from '../lib/api';
import { formatDate, formatDateTime } from '../lib/format';
import type { ArticleResponse, LockState } from '../lib/types';
import { useAuth } from '../context/AuthContext';
import { RichContent, type TocItem } from '../components/content/RichContent';
import { LockBanner } from '../components/LockBanner';
import { ConfirmDialog, Empty, Spinner, StatusBadge, VisibilityBadge, useToast } from '../components/ui';
import { openChat } from '../components/ChatWidget';

export function ArticleHeader({ a, showStatus }: { a: ArticleResponse['article']; showStatus?: boolean }) {
  return (
    <header className="article-header">
      <nav className="breadcrumb" aria-label="Trilha">
        <Link to="/">Início</Link> <span aria-hidden>›</span>
        {a.category ? <Link to={`/busca?category=${a.category.id}`}>{a.category.name}</Link> : <span>Sem categoria</span>}
      </nav>
      <h1>{a.title}</h1>
      {a.summary && <p className="article-summary">{a.summary}</p>}
      <div className="result-meta">
        {a.system && <span className="badge">{a.system.name}</span>}
        {showStatus && <StatusBadge status={a.status} />}
        {showStatus && <VisibilityBadge visibility={a.visibility} />}
        <span>Atualizado em {formatDate(a.updatedAt)}</span>
        {a.tags.map((t) => (
          <Link key={t.id} className="badge" to={`/busca?tag=${t.slug}`}>
            #{t.name}
          </Link>
        ))}
      </div>
    </header>
  );
}

export function ArticlePage() {
  const { slug = '' } = useParams();
  const { isInternal } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [toc, setToc] = useState<TocItem[]>([]);
  const [confirm, setConfirm] = useState<null | 'publish' | 'unpublish' | 'archive' | 'unarchive'>(null);
  const onToc = useCallback((t: TocItem[]) => setToc(t), []);

  const { data, isLoading, error } = useQuery({
    queryKey: ['article', slug],
    queryFn: () => get<ArticleResponse>(`/api/articles/${encodeURIComponent(slug)}`),
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });
  const articleId = data?.article.id;
  const canEdit = !!data?.capabilities.canEdit;

  // Estado do bloqueio atualizado periodicamente para quem pode editar.
  const lockQuery = useQuery({
    queryKey: ['lock', articleId],
    queryFn: () => get<{ lock: LockState }>(`/api/articles/${articleId}/lock`).then((r) => r.lock),
    enabled: isInternal && !!articleId && canEdit,
    refetchInterval: 8000,
    initialData: data?.lock ?? undefined,
  });

  if (isLoading) return <Spinner />;
  if (error || !data) {
    return (
      <div className="page page-narrow">
        <Empty title="Artigo não encontrado">
          <p>O artigo pode ter sido removido ou você não possui acesso a ele.</p>
          <Link to="/" className="btn">
            <ArrowLeft size={16} aria-hidden /> Voltar ao início
          </Link>
        </Empty>
      </div>
    );
  }

  const { article: a, capabilities: cap, related } = data;
  const lock = lockQuery.data ?? data.lock;
  // Qualquer bloqueio ativo (inclusive do próprio usuário em outra aba) impede abrir uma nova edição.
  const lockedByOther = !!lock?.locked;

  const runStatus = async (action: NonNullable<typeof confirm>) => {
    await post(`/api/articles/${a.id}/${action}`, { expectedVersion: a.version });
    await queryClient.invalidateQueries({ queryKey: ['article', slug] });
    toast('success', { publish: 'Artigo publicado.', unpublish: 'Artigo despublicado.', archive: 'Artigo arquivado.', unarchive: 'Artigo restaurado como rascunho.' }[action]);
    setConfirm(null);
  };

  return (
    <div className="page">
      {isInternal && (cap.canEdit || cap.canPublish || cap.canViewHistory || cap.canUnpublish || cap.canArchive || cap.canUnarchive) && (
        <div className="card card-body" style={{ marginBottom: 20 }}>
          <div className="row">
            <strong>Gestão do artigo</strong>
            <StatusBadge status={a.status} />
            <VisibilityBadge visibility={a.visibility} />
            <span className="small muted">Versão {a.version}</span>
            <span className="spacer" />
            {cap.canViewHistory && (
              <Link className="btn btn-sm" to={`/interno/artigos/${a.id}/historico`}>
                <History size={16} aria-hidden /> Histórico de alterações
              </Link>
            )}
            {(cap.canEdit || cap.editBlockedReason) && (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={!cap.canEdit || lockedByOther}
                title={!cap.canEdit ? (cap.editBlockedReason ?? undefined) : lockedByOther ? 'Edição bloqueada: outro usuário está editando' : undefined}
                onClick={() => navigate(`/interno/artigos/${a.id}/editar`)}
                data-testid="edit-article"
              >
                <Pencil size={16} aria-hidden /> Editar artigo
              </button>
            )}
            {cap.canPublish && (
              <button type="button" className="btn btn-sm" disabled={lockedByOther} onClick={() => setConfirm('publish')}>
                <Send size={16} aria-hidden /> Publicar
              </button>
            )}
            {cap.canUnpublish && (
              <button type="button" className="btn btn-sm" disabled={lockedByOther} onClick={() => setConfirm('unpublish')}>
                <EyeOff size={16} aria-hidden /> Despublicar
              </button>
            )}
            {cap.canArchive && (
              <button type="button" className="btn btn-sm" disabled={lockedByOther} onClick={() => setConfirm('archive')}>
                <Archive size={16} aria-hidden /> Arquivar
              </button>
            )}
            {cap.canUnarchive && (
              <button type="button" className="btn btn-sm" onClick={() => setConfirm('unarchive')}>
                <ArchiveRestore size={16} aria-hidden /> Restaurar
              </button>
            )}
          </div>
          {!cap.canEdit && cap.editBlockedReason && <p className="small muted" style={{ margin: '8px 0 0' }}>{cap.editBlockedReason}</p>}
          {lock && lockedByOther && (
            <div style={{ marginTop: 12 }}>
              <LockBanner lock={lock} />
            </div>
          )}
          {a.status !== 'published' && (
            <p className="small muted" style={{ margin: '8px 0 0' }}>
              <Eye size={14} aria-hidden style={{ verticalAlign: 'middle' }} /> Pré-visualização: este artigo não está visível ao público.
            </p>
          )}
        </div>
      )}

      <div className="article-layout">
        <article>
          <ArticleHeader a={a} />
          <RichContent html={a.contentHtml} onToc={onToc} />
          <footer className="small muted" style={{ marginTop: 32, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            {a.publishedAt && <>Publicado em {formatDateTime(a.publishedAt)}. </>}Última atualização em {formatDateTime(a.updatedAt)}.
          </footer>
          <div className="card card-body" style={{ marginTop: 24 }}>
            <strong>Este artigo não resolveu seu problema?</strong>
            <div className="btn-group" style={{ marginTop: 10 }}>
              <button type="button" className="btn" onClick={openChat}>
                <Bot size={16} aria-hidden /> Perguntar ao assistente
              </button>
              <Link className="btn btn-primary" to="/tickets/novo" state={{ draft: { title: '', description: `Consultei o artigo "${a.title}" e o problema continua.` } }}>
                <Ticket size={16} aria-hidden /> Abrir ticket
              </Link>
            </div>
          </div>
        </article>
        <aside className="stack">
          {toc.length > 1 && (
            <nav className="card card-body toc" aria-label="Nesta página">
              <strong className="small">Nesta página</strong>
              <ol>
                {toc.map((t) => (
                  <li key={t.id} className={`level-${t.level}`}>
                    <a href={`#${t.id}`}>{t.text}</a>
                  </li>
                ))}
              </ol>
            </nav>
          )}
          {related.length > 0 && (
            <section className="card">
              <div className="card-header">
                <h2 style={{ fontSize: '1rem' }}>Artigos relacionados</h2>
              </div>
              <ul className="article-list">
                {related.map((r) => (
                  <li key={r.id}>
                    <Link to={`/artigos/${r.slug}`}>{r.title}</Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <Link to="/" className="btn btn-sm">
            <ArrowLeft size={16} aria-hidden /> Voltar ao início
          </Link>
        </aside>
      </div>

      {confirm && (
        <ConfirmDialog
          title={{ publish: 'Publicar artigo', unpublish: 'Despublicar artigo', archive: 'Arquivar artigo', unarchive: 'Restaurar artigo' }[confirm]}
          message={
            {
              publish: `O artigo ficará disponível para o público ${a.visibility === 'external' ? 'EXTERNO (clientes e usuários internos)' : 'INTERNO (somente usuários internos autorizados)'}.`,
              unpublish: 'O artigo deixará de ser exibido ao público, na pesquisa e no chat com IA.',
              archive: 'O artigo será arquivado e deixará de ser exibido. Ele poderá ser restaurado como rascunho.',
              unarchive: 'O artigo voltará a ser um rascunho editável.',
            }[confirm]
          }
          confirmLabel={{ publish: 'Publicar', unpublish: 'Despublicar', archive: 'Arquivar', unarchive: 'Restaurar' }[confirm]}
          danger={confirm === 'archive' || confirm === 'unpublish'}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            try {
              await runStatus(confirm);
            } catch (err) {
              throw new Error(errorMessage(err));
            }
          }}
        />
      )}
    </div>
  );
}
