import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Eye, History, Lock, RefreshCw, Save, Send, X } from 'lucide-react';
import { VISIBILITY_LABELS } from '@shared/domain';
import { ApiError, del, errorMessage, fieldErrors, get, post, put } from '../../lib/api';
import { formatDateTime, formatTime } from '../../lib/format';
import type { Article, ArticleResponse, LockState, Taxonomy } from '../../lib/types';
import { useAuth } from '../../context/AuthContext';
import { RichEditor } from '../../components/editor/RichEditor';
import { RichContent } from '../../components/content/RichContent';
import { LockBanner } from '../../components/LockBanner';
import { Alert, Button, ConfirmDialog, Field, Modal, Spinner, StatusBadge, TagInput, VisibilityBadge, useToast } from '../../components/ui';
import { ArticleHeader } from '../Article';

interface FormState {
  title: string;
  summary: string;
  contentHtml: string;
  categoryId: string;
  systemId: string;
  keywords: string[];
  tags: string[];
  visibility: '' | 'internal' | 'external';
}

const EMPTY: FormState = { title: '', summary: '', contentHtml: '', categoryId: '', systemId: '', keywords: [], tags: [], visibility: '' };

function fromArticle(a: Article): FormState {
  return {
    title: a.title,
    summary: a.summary,
    contentHtml: a.contentHtml,
    categoryId: a.category?.id ?? '',
    systemId: a.system?.id ?? '',
    keywords: a.keywords,
    tags: a.tags.map((t) => t.name),
    visibility: a.visibility,
  };
}

interface LockInfo {
  token: string;
  acquiredAt: string;
  expiresAt: string;
}

export function ArticleEditorPage() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const toast = useToast();
  const { user, config, can } = useAuth();

  const [article, setArticle] = useState<Article | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [editorKey, setEditorKey] = useState(0);
  const [version, setVersion] = useState(1);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(!isNew);
  const [fatal, setFatal] = useState<string | null>(null);
  const [lock, setLock] = useState<LockInfo | null>(null);
  const [blocked, setBlocked] = useState<LockState | null>(null);
  const [lostLock, setLostLock] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [saving, setSaving] = useState<null | 'draft' | 'finish' | 'publish'>(null);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [preview, setPreview] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const lockRef = useRef<LockInfo | null>(null);
  lockRef.current = lock;

  const taxonomy = useQuery({ queryKey: ['taxonomy'], queryFn: () => get<Taxonomy>('/api/taxonomy') });
  const canPublish = can('articles.publish');

  // ---------------------------------------------------------------------
  // Aquisição do bloqueio de edição
  // ---------------------------------------------------------------------
  const acquire = useCallback(
    async (keepContent: boolean) => {
      if (!id) return false;
      try {
        const res = await post<{ lockToken: string; acquiredAt: string; expiresAt: string; article: Article }>(`/api/articles/${id}/lock`);
        setLock({ token: res.lockToken, acquiredAt: res.acquiredAt, expiresAt: res.expiresAt });
        setBlocked(null);
        setLostLock(null);
        if (!keepContent) {
          setArticle(res.article);
          setForm(fromArticle(res.article));
          setVersion(res.article.version);
          setEditorKey((k) => k + 1);
          setDirty(false);
        } else if (res.article.version !== version) {
          setConflict(`O artigo foi alterado por outra pessoa (versão ${res.article.version}) enquanto você estava sem o bloqueio. Recarregue a versão atual antes de salvar.`);
        }
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.code === 'ARTICLE_LOCKED') {
          const holder = (err.details as { holder?: { name: string; acquiredAt: string; userId: string } })?.holder;
          setBlocked({ locked: true, mine: holder?.userId === user?.id, holder: holder ? { id: holder.userId, name: holder.name } : undefined, acquiredAt: holder?.acquiredAt });
        } else if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
          setFatal(err.message);
        } else {
          setFatal(errorMessage(err));
        }
        return false;
      }
    },
    [id, user?.id, version],
  );

  useEffect(() => {
    if (isNew) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const ok = await acquire(false);
      if (!ok && !cancelled) {
        // Sem o bloqueio: carrega o artigo apenas para visualização.
        try {
          const res = await get<ArticleResponse>(`/api/articles/${id}?preview=1`);
          if (!cancelled) {
            setArticle(res.article);
            setForm(fromArticle(res.article));
            setVersion(res.article.version);
            setEditorKey((k) => k + 1);
          }
        } catch {
          /* fatal já tratado */
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Enquanto bloqueado por outra pessoa, consulta periodicamente se ficou disponível.
  const lockPoll = useQuery({
    queryKey: ['lock', id, 'editor'],
    queryFn: () => get<{ lock: LockState }>(`/api/articles/${id}/lock`).then((r) => r.lock),
    enabled: !!id && !!blocked,
    refetchInterval: 6000,
  });
  const nowAvailable = !!blocked && lockPoll.data && !lockPoll.data.locked;
  const blockedState = blocked && lockPoll.data?.locked ? lockPoll.data : blocked;

  // ---------------------------------------------------------------------
  // Renovação periódica (lease) e liberação ao sair
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (!lock || !id) return;
    const interval = (config?.lock.heartbeatSeconds ?? 30) * 1000;
    const timer = setInterval(async () => {
      try {
        const res = await post<{ expiresAt: string }>(`/api/articles/${id}/lock/heartbeat`, { lockToken: lock.token });
        setLock((l) => (l ? { ...l, expiresAt: res.expiresAt } : l));
      } catch (err) {
        if (err instanceof ApiError && err.code === 'LOCK_EXPIRED') {
          // O lease expirou (ex.: computador suspenso): tenta readquirir mantendo o conteúdo.
          setLock(null);
          const ok = await acquire(true);
          if (ok) toast('info', 'O bloqueio de edição expirou e foi renovado automaticamente.');
          else setLostLock('Seu bloqueio de edição expirou e outro usuário iniciou a edição. Copie suas alterações antes de sair; elas não podem ser salvas.');
        } else if (err instanceof ApiError && (err.code === 'ARTICLE_LOCKED' || err.status === 403)) {
          setLock(null);
          setLostLock(err.status === 403 ? err.message : 'O bloqueio de edição foi liberado por um administrador ou assumido por outro usuário. Suas alterações não salvas não podem mais ser gravadas.');
        }
      }
    }, interval);
    return () => clearInterval(timer);
  }, [lock?.token, id, config?.lock.heartbeatSeconds, acquire, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!id) return;
    const onPageHide = () => {
      const l = lockRef.current;
      if (l) navigator.sendBeacon(`/api/articles/${id}/lock/beacon`, new Blob([JSON.stringify({ lockToken: l.token })], { type: 'text/plain' }));
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      // Saindo do modo de edição pela navegação interna: libera o bloqueio.
      const l = lockRef.current;
      if (l) void del(`/api/articles/${id}/lock`, { lockToken: l.token }).catch(() => undefined);
    };
  }, [id]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname && !saving);

  // ---------------------------------------------------------------------
  // Salvamento
  // ---------------------------------------------------------------------
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
  };

  const payload = () => ({
    title: form.title,
    summary: form.summary,
    contentHtml: form.contentHtml,
    categoryId: form.categoryId || null,
    systemId: form.systemId || null,
    keywords: form.keywords,
    tags: form.tags,
    visibility: form.visibility || undefined,
  });

  const handleSaveError = (err: unknown) => {
    setErrors(fieldErrors(err));
    if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') setConflict(err.message);
    else if (err instanceof ApiError && ['LOCK_EXPIRED', 'LOCK_NOT_HELD', 'ARTICLE_LOCKED'].includes(err.code)) {
      setLock(null);
      setLostLock(err.message);
    }
    toast('error', errorMessage(err));
  };

  const save = async (mode: 'draft' | 'finish' | 'publish') => {
    setErrors({});
    setSaving(mode);
    try {
      if (isNew) {
        const res = await post<{ article: Article }>('/api/articles', payload());
        setDirty(false);
        toast('success', 'Rascunho criado.');
        if (mode === 'finish') navigate(`/artigos/${res.article.slug}`, { replace: true });
        else navigate(`/interno/artigos/${res.article.id}/editar`, { replace: true });
        return;
      }
      if (!lock) throw new ApiError(409, 'LOCK_NOT_HELD', 'Você não possui o bloqueio de edição.');
      let current = version;
      if (dirty || mode !== 'publish') {
        const res = await put<{ article: Article; changed: boolean; lockReleased: boolean }>(`/api/articles/${id}`, {
          ...payload(),
          lockToken: lock.token,
          expectedVersion: version,
          finish: mode === 'finish',
        });
        current = res.article.version;
        setVersion(current);
        setArticle(res.article);
        setDirty(false);
        setLastSaved(new Date());
        if (mode === 'finish') {
          setLock(null);
          toast('success', res.changed ? 'Alterações salvas e edição concluída.' : 'Edição concluída (sem alterações).');
          navigate(`/artigos/${res.article.slug}`);
          return;
        }
        if (mode === 'draft') toast('success', res.changed ? 'Alterações salvas.' : 'Nenhuma alteração para salvar.');
      }
      if (mode === 'publish') {
        const res = await post<{ article: Article }>(`/api/articles/${id}/publish`, { expectedVersion: current, lockToken: lock.token });
        await del(`/api/articles/${id}/lock`, { lockToken: lock.token }).catch(() => undefined);
        setLock(null);
        toast('success', 'Artigo publicado.');
        navigate(`/artigos/${res.article.slug}`);
      }
    } catch (err) {
      handleSaveError(err);
    } finally {
      setSaving(null);
    }
  };

  const cancel = async () => {
    if (lock && id) await del(`/api/articles/${id}/lock`, { lockToken: lock.token }).catch(() => undefined);
    setLock(null);
    setDirty(false);
    setConfirmCancel(false);
    navigate(article ? `/artigos/${article.slug}` : '/interno/artigos');
  };

  const reloadCurrent = async () => {
    setConflict(null);
    if (lock && id) await del(`/api/articles/${id}/lock`, { lockToken: lock.token }).catch(() => undefined);
    setLock(null);
    setLoading(true);
    await acquire(false);
    setLoading(false);
  };

  if (loading) return <Spinner label="Abrindo o editor…" />;
  if (fatal && !article) {
    return (
      <div className="page">
        <Alert kind="danger" title="Não foi possível abrir o editor">
          {fatal}
        </Alert>
      </div>
    );
  }

  const editable = isNew || (!!lock && !lostLock);
  const showPublish = canPublish && (isNew ? false : article && ['draft', 'unpublished'].includes(article.status));
  const previewArticle: Article = {
    ...(article ?? ({} as Article)),
    title: form.title || 'Sem título',
    summary: form.summary,
    contentHtml: form.contentHtml,
    category: taxonomy.data?.categories.find((c) => c.id === form.categoryId) ?? null,
    system: taxonomy.data?.systems.find((s) => s.id === form.systemId) ?? null,
    tags: form.tags.map((t) => ({ id: t, name: t, slug: t })),
    keywords: form.keywords,
    visibility: (form.visibility || 'internal') as 'internal',
    status: article?.status ?? 'draft',
    updatedAt: article?.updatedAt ?? new Date().toISOString(),
  } as Article;

  return (
    <div className="page" style={{ maxWidth: 1320 }}>
      <div className="page-header">
        <div>
          <h1>{isNew ? 'Novo artigo' : 'Editar artigo'}</h1>
          {article && (
            <p className="row" style={{ gap: 8 }}>
              <StatusBadge status={article.status} />
              {form.visibility && <VisibilityBadge visibility={form.visibility} />}
              <span className="small">Versão {version}</span>
              {lastSaved && <span className="save-state">Salvo às {formatTime(lastSaved)}</span>}
              {dirty && <span className="save-state">· Alterações não salvas</span>}
            </p>
          )}
        </div>
        <div className="btn-group">
          {!isNew && can('articles.history') && (
            <Link className="btn" to={`/interno/artigos/${id}/historico`}>
              <History size={16} aria-hidden /> Histórico de alterações
            </Link>
          )}
          <Button onClick={() => setPreview(true)}>
            <Eye size={16} aria-hidden /> Visualizar artigo
          </Button>
        </div>
      </div>

      {blockedState && blockedState.locked && (
        <>
          <LockBanner lock={blockedState} />
          <p className="small muted">O editor está em modo de visualização. O botão de edição será liberado quando o artigo estiver disponível.</p>
        </>
      )}
      {nowAvailable && (
        <Alert kind="success" title="O artigo está disponível para edição.">
          <Button size="sm" variant="primary" onClick={() => acquire(false)} style={{ marginTop: 6 }}>
            <Lock size={14} aria-hidden /> Editar agora
          </Button>
        </Alert>
      )}
      {lostLock && (
        <Alert kind="danger" title="Edição interrompida">
          {lostLock}
          <div style={{ marginTop: 8 }}>
            <Button size="sm" onClick={() => acquire(true)}>
              <RefreshCw size={14} aria-hidden /> Tentar reabrir a edição
            </Button>
          </div>
        </Alert>
      )}
      {conflict && (
        <Alert kind="danger" title="Conflito de versão">
          {conflict}
          <div style={{ marginTop: 8 }}>
            <Button size="sm" onClick={reloadCurrent}>
              <RefreshCw size={14} aria-hidden /> Recarregar a versão atual (descarta suas alterações)
            </Button>
          </div>
        </Alert>
      )}

      <div className="editor-layout" style={{ marginTop: 12 }}>
        <div className="stack">
          {lock && (
            <div className="editing-identity" data-testid="editing-identity">
              <CheckCircle2 size={16} aria-hidden />
              <span>
                Você (<strong>{user?.name}</strong>) está editando este artigo desde {formatDateTime(lock.acquiredAt)}. Os demais usuários estão em modo de visualização.
              </span>
            </div>
          )}
          <Field label="Título" htmlFor="title" required error={errors.title}>
            <input id="title" className="input" value={form.title} disabled={!editable} onChange={(e) => set('title', e.target.value)} maxLength={200} aria-invalid={!!errors.title} style={{ fontSize: '1.15rem', fontWeight: 600 }} />
          </Field>
          <Field label="Resumo" htmlFor="summary" required error={errors.summary} hint="Exibido na pesquisa e no topo do artigo.">
            <textarea id="summary" className="textarea" style={{ minHeight: 70 }} value={form.summary} disabled={!editable} onChange={(e) => set('summary', e.target.value)} maxLength={1000} aria-invalid={!!errors.summary} />
          </Field>
          <div>
            <span className="label">Conteúdo</span>
            {errors.contentHtml && <div className="small" style={{ color: 'var(--danger)' }}>{errors.contentHtml}</div>}
            <div style={{ marginTop: 6 }}>
              <RichEditor
                key={editorKey}
                initialHtml={form.contentHtml}
                editable={editable}
                onChange={(html) => set('contentHtml', html)}
              />
            </div>
          </div>
        </div>

        <aside className="editor-side stack">
          <div className="card card-body stack">
            <Field label="Visibilidade" required error={errors.visibility}>
              <div className="segmented" role="group" aria-label="Visibilidade">
                {(['internal', 'external'] as const).map((v) => (
                  <button key={v} type="button" aria-pressed={form.visibility === v} disabled={!editable} onClick={() => set('visibility', v)}>
                    {VISIBILITY_LABELS[v]}
                  </button>
                ))}
              </div>
              <span className="hint">
                {form.visibility === 'external'
                  ? 'Clientes e usuários internos poderão ver o artigo depois de publicado.'
                  : form.visibility === 'internal'
                    ? 'Somente usuários internos autorizados poderão ver o artigo.'
                    : 'Escolha obrigatoriamente o público do artigo.'}
              </span>
            </Field>
            <Field label="Categoria" htmlFor="category" required error={errors.categoryId}>
              <select id="category" className="select" value={form.categoryId} disabled={!editable} onChange={(e) => set('categoryId', e.target.value)} aria-invalid={!!errors.categoryId}>
                <option value="">Selecione…</option>
                {taxonomy.data?.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Sistema relacionado" htmlFor="system" required error={errors.systemId}>
              <select id="system" className="select" value={form.systemId} disabled={!editable} onChange={(e) => set('systemId', e.target.value)} aria-invalid={!!errors.systemId}>
                <option value="">Selecione…</option>
                {taxonomy.data?.systems.filter((s) => s.active || s.id === form.systemId).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Palavras-chave" htmlFor="keywords" required error={errors.keywords} hint="Pressione Enter ou vírgula para adicionar.">
              <TagInput id="keywords" value={form.keywords} onChange={(v) => editable && set('keywords', v)} placeholder="ex.: exportar, relatório" />
            </Field>
            <Field label="Tags" htmlFor="tags" error={errors.tags} hint={can('categories.manage') ? 'Novas tags serão cadastradas.' : 'Somente tags já cadastradas.'}>
              <TagInput id="tags" value={form.tags} onChange={(v) => editable && set('tags', v)} suggestions={taxonomy.data?.tags.map((t) => t.name)} />
            </Field>
          </div>

          <div className="card card-body stack">
            <Button variant="default" onClick={() => save('draft')} loading={saving === 'draft'} disabled={!editable || !!saving}>
              <Save size={16} aria-hidden /> {isNew ? 'Salvar rascunho' : 'Salvar'}
            </Button>
            <Button variant="primary" onClick={() => save('finish')} loading={saving === 'finish'} disabled={!editable || !!saving}>
              <CheckCircle2 size={16} aria-hidden /> Salvar e concluir edição
            </Button>
            {showPublish && (
              <Button variant="primary" onClick={() => save('publish')} loading={saving === 'publish'} disabled={!editable || !!saving} style={{ background: 'var(--success)', borderColor: 'var(--success)' }}>
                <Send size={16} aria-hidden /> Salvar e publicar
              </Button>
            )}
            {!canPublish && !isNew && <p className="tiny muted" style={{ margin: 0 }}>Você pode salvar rascunhos; a publicação exige permissão específica.</p>}
            <Button onClick={() => (dirty ? setConfirmCancel(true) : cancel())} disabled={!!saving}>
              <X size={16} aria-hidden /> {lock ? 'Cancelar edição' : 'Sair'}
            </Button>
            {article && (
              <p className="tiny muted" style={{ margin: 0 }}>
                Criado por {article.author.name} · última atualização em {formatDateTime(article.updatedAt)}
                {article.publishedBy && <> · publicado por {article.publishedBy.name}</>}
              </p>
            )}
          </div>
        </aside>
      </div>

      {preview && (
        <Modal title="Pré-visualização do artigo" onClose={() => setPreview(false)} wide>
          <Alert kind="info">
            Pré-visualização para o público <strong>{form.visibility ? VISIBILITY_LABELS[form.visibility].toLowerCase() : 'ainda não definido'}</strong>. Esta visualização não publica o artigo e inclui alterações ainda não salvas.
          </Alert>
          <div style={{ marginTop: 16 }}>
            <ArticleHeader a={previewArticle} />
            <RichContent html={form.contentHtml} />
          </div>
        </Modal>
      )}
      {confirmCancel && (
        <ConfirmDialog
          title="Descartar alterações?"
          message="Existem alterações não salvas. Ao cancelar, elas serão perdidas e o bloqueio de edição será liberado."
          confirmLabel="Descartar e sair"
          danger
          onCancel={() => setConfirmCancel(false)}
          onConfirm={cancel}
        />
      )}
      {blocker.state === 'blocked' && (
        <ConfirmDialog
          title="Sair sem salvar?"
          message="Existem alterações não salvas que serão perdidas."
          confirmLabel="Sair sem salvar"
          danger
          onCancel={() => blocker.reset?.()}
          onConfirm={() => blocker.proceed?.()}
        />
      )}
    </div>
  );
}
