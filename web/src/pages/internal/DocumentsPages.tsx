import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, FilePlus2, FileStack, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { DOCUMENT_STATUS_LABELS, DOCUMENT_STATUSES, VISIBILITY_LABELS } from '@shared/domain';
import { formatBytes } from '@shared/uploads';
import { ApiError, del, errorMessage, fieldErrors, get, post, put, qs, upload } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import type { Taxonomy } from '../../lib/types';
import { useAuth } from '../../context/AuthContext';
import { PageHeader } from '../../components/Layout';
import { Alert, Button, ConfirmDialog, Empty, Field, FileDropzone, Modal, Pagination, Spinner, StatusBadge, TagInput, VisibilityBadge, useToast } from '../../components/ui';

export interface DocumentItem {
  id: string;
  title: string;
  category: { id: string; name: string } | null;
  system: { id: string; name: string } | null;
  keywords: string[];
  visibility: 'internal' | 'external';
  status: string;
  reviewStatus: string;
  pageCount: number | null;
  warnings: string[];
  errorMessage: string | null;
  attempts: number;
  file: { id: string; name: string; mimeType: string; size: number; url: string };
  uploadedBy?: string;
  reviewedBy?: string | null;
  reviewedAt: string | null;
  processedAt: string | null;
  removedAt: string | null;
  createdAt: string;
  characters: number;
  extractedText?: string | null;
  relatedArticles: Array<{ id: string; slug: string; title: string; status?: string }>;
}

export function DocumentsPage() {
  const [status, setStatus] = useState('');
  const [review, setReview] = useState('');
  const [page, setPage] = useState(1);
  const [importing, setImporting] = useState(false);
  const list = useQuery({
    queryKey: ['documents', status, review, page],
    queryFn: () => get<{ total: number; items: DocumentItem[] }>(`/api/documents${qs({ status, review, page, pageSize: 20 })}`),
    refetchInterval: (q) => ((q.state.data?.items ?? []).some((d) => ['pending', 'processing'].includes(d.status)) ? 3000 : 30_000),
  });
  return (
    <div className="page">
      <PageHeader
        title="Documentos importados"
        subtitle="PDF e Word processados para a pesquisa e a IA. Nenhum documento é publicado automaticamente: revise e aprove antes de disponibilizar."
        icon={<FileStack size={24} aria-hidden />}
        actions={
          <Button variant="primary" onClick={() => setImporting(true)}>
            <Upload size={16} aria-hidden /> Importar documento
          </Button>
        }
      />
      <div className="card card-body row" style={{ marginBottom: 16 }}>
        <select className="select" style={{ width: 'auto' }} aria-label="Status do processamento" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))}>
          <option value="">Todos os status</option>
          {DOCUMENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {DOCUMENT_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <select className="select" style={{ width: 'auto' }} aria-label="Revisão" value={review} onChange={(e) => (setReview(e.target.value), setPage(1))}>
          <option value="">Todas as revisões</option>
          <option value="pending_review">Aguardando revisão</option>
          <option value="approved">Aprovados</option>
          <option value="rejected">Rejeitados</option>
        </select>
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : !list.data?.items.length ? (
        <div className="card">
          <Empty title="Nenhum documento importado." />
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Título</th>
                <th>Arquivo</th>
                <th>Visibilidade</th>
                <th>Processamento</th>
                <th>Revisão</th>
                <th>Enviado por</th>
                <th>Data</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((d) => (
                <tr key={d.id}>
                  <td>
                    <Link to={`/interno/documentos/${d.id}`}>{d.title}</Link>
                  </td>
                  <td className="small">
                    {d.file.name} <span className="muted">({formatBytes(d.file.size)})</span>
                  </td>
                  <td>
                    <VisibilityBadge visibility={d.visibility} />
                  </td>
                  <td>
                    <StatusBadge status={d.status} />
                  </td>
                  <td>
                    <StatusBadge status={d.reviewStatus} />
                  </td>
                  <td className="small">{d.uploadedBy}</td>
                  <td className="small">{formatDateTime(d.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data && <Pagination page={page} pageSize={20} total={list.data.total} onChange={setPage} />}
      {importing && <ImportModal onClose={() => setImporting(false)} />}
    </div>
  );
}

function ImportModal({ onClose }: { onClose: () => void }) {
  const { config } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const taxonomy = useQuery({ queryKey: ['taxonomy'], queryFn: () => get<Taxonomy>('/api/taxonomy') });
  const [files, setFiles] = useState<File[]>([]);
  const [meta, setMeta] = useState({ title: '', categoryId: '', systemId: '', keywords: [] as string[], visibility: '' as '' | 'internal' | 'external' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const accept = config?.docConversion ? '.pdf,.docx,.doc' : '.pdf,.docx';

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!files[0]) e.file = 'Selecione o arquivo.';
    if (meta.title.trim().length < 3) e.title = 'Informe o título.';
    if (!meta.visibility) e.visibility = 'Defina a visibilidade.';
    const f = files[0];
    if (f && config && f.size > config.uploads.maxDocumentMb * 1024 * 1024) e.file = `O arquivo excede ${config.uploads.maxDocumentMb} MB.`;
    if (f && !/\.(pdf|docx|doc)$/i.test(f.name)) e.file = 'Formato não permitido. Envie PDF ou DOCX.';
    setErrors(e);
    if (Object.keys(e).length) return;
    const form = new FormData();
    form.append('title', meta.title);
    form.append('visibility', meta.visibility);
    if (meta.categoryId) form.append('categoryId', meta.categoryId);
    if (meta.systemId) form.append('systemId', meta.systemId);
    form.append('keywords', meta.keywords.join(','));
    form.append('file', f!, f!.name);
    setError(null);
    try {
      setProgress(0);
      const res = await upload<{ document: { id: string } }>('/api/documents', form, setProgress);
      await queryClient.invalidateQueries({ queryKey: ['documents'] });
      navigate(`/interno/documentos/${res.document.id}`);
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(err instanceof ApiError && err.code === 'DUPLICATE_DOCUMENT' ? `${err.message} Verifique a lista de documentos.` : errorMessage(err));
    } finally {
      setProgress(null);
    }
  };

  return (
    <Modal
      title="Importar documento"
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={submit} loading={progress !== null}>
            Enviar e processar
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Arquivo" required error={errors.file}>
          <FileDropzone
            files={files}
            onChange={(fs) => {
              setFiles(fs.slice(-1));
              if (fs[0] && !meta.title) setMeta((m) => ({ ...m, title: fs[0]!.name.replace(/\.[^.]+$/, '') }));
            }}
            multiple={false}
            accept={accept}
            label="Selecione ou arraste um arquivo PDF ou DOCX"
            hint={`${config?.docConversion ? 'PDF, DOCX ou DOC' : 'PDF ou DOCX'} — até ${config?.uploads.maxDocumentMb ?? '-'} MB.`}
            invalid={!!errors.file}
          />
        </Field>
        <div className="grid grid-2">
          <Field label="Título" htmlFor="doc-title" required error={errors.title}>
            <input id="doc-title" className="input" value={meta.title} onChange={(e) => setMeta({ ...meta, title: e.target.value })} />
          </Field>
          <Field label="Visibilidade" required error={errors.visibility}>
            <div className="segmented" role="group" aria-label="Visibilidade">
              {(['internal', 'external'] as const).map((v) => (
                <button key={v} type="button" aria-pressed={meta.visibility === v} onClick={() => setMeta({ ...meta, visibility: v })}>
                  {VISIBILITY_LABELS[v]}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Categoria" htmlFor="doc-cat">
            <select id="doc-cat" className="select" value={meta.categoryId} onChange={(e) => setMeta({ ...meta, categoryId: e.target.value })}>
              <option value="">—</option>
              {taxonomy.data?.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Sistema" htmlFor="doc-sys">
            <select id="doc-sys" className="select" value={meta.systemId} onChange={(e) => setMeta({ ...meta, systemId: e.target.value })}>
              <option value="">—</option>
              {taxonomy.data?.systems.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Palavras-chave" htmlFor="doc-kw">
          <TagInput id="doc-kw" value={meta.keywords} onChange={(v) => setMeta({ ...meta, keywords: v })} />
        </Field>
        {progress !== null && <p className="small muted">Enviando… {progress}%</p>}
        {error && <Alert kind="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}

export function DocumentDetailPage() {
  const { id = '' } = useParams();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const taxonomy = useQuery({ queryKey: ['taxonomy'], queryFn: () => get<Taxonomy>('/api/taxonomy') });
  const doc = useQuery({
    queryKey: ['document', id],
    queryFn: () => get<{ document: DocumentItem }>(`/api/documents/${id}`).then((r) => r.document),
    refetchInterval: (q) => (['pending', 'processing'].includes(q.state.data?.status ?? '') ? 2000 : false),
  });
  const [confirm, setConfirm] = useState<null | 'remove' | 'reprocess' | 'reject'>(null);
  const [editMeta, setEditMeta] = useState<null | { title: string; categoryId: string; systemId: string; keywords: string[]; visibility: 'internal' | 'external' }>(null);
  const [error, setError] = useState<string | null>(null);

  if (doc.isLoading) return <Spinner />;
  if (!doc.data) return <div className="page"><Alert kind="danger">{errorMessage(doc.error)}</Alert></div>;
  const d = doc.data;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['document', id] });
  const processed = ['processed', 'processed_with_warnings'].includes(d.status);

  const action = async (fn: () => Promise<unknown>, msg: string) => {
    setError(null);
    try {
      await fn();
      toast('success', msg);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="page">
      <PageHeader
        title={d.title}
        subtitle={
          <span className="row" style={{ gap: 8 }}>
            <StatusBadge status={d.status} /> <StatusBadge status={d.reviewStatus} /> <VisibilityBadge visibility={d.visibility} />
            {d.removedAt && <span className="badge badge-danger">Removido em {formatDateTime(d.removedAt)}</span>}
          </span>
        }
        actions={
          !d.removedAt && (
            <>
              <a className="btn" href={d.file.url}>
                <Download size={16} aria-hidden /> Original
              </a>
              <Button onClick={() => setEditMeta({ title: d.title, categoryId: d.category?.id ?? '', systemId: d.system?.id ?? '', keywords: d.keywords, visibility: d.visibility })}>Classificação</Button>
              {processed && d.reviewStatus !== 'approved' && (
                <Button variant="primary" onClick={() => action(() => post(`/api/documents/${id}/approve`), 'Documento aprovado e disponibilizado.')}>
                  <Check size={16} aria-hidden /> Aprovar
                </Button>
              )}
              {processed && d.reviewStatus !== 'rejected' && (
                <Button onClick={() => setConfirm('reject')}>
                  <X size={16} aria-hidden /> Rejeitar
                </Button>
              )}
              <Button onClick={() => setConfirm('reprocess')} disabled={d.status === 'processing'}>
                <RefreshCw size={16} aria-hidden /> Reprocessar
              </Button>
              {processed && (
                <Button
                  onClick={() =>
                    action(async () => {
                      const res = await post<{ article: { id: string } }>(`/api/documents/${id}/create-article`);
                      navigate(`/interno/artigos/${res.article.id}/editar`);
                    }, 'Rascunho de artigo criado.')
                  }
                >
                  <FilePlus2 size={16} aria-hidden /> Gerar artigo
                </Button>
              )}
              <Button variant="danger" onClick={() => setConfirm('remove')}>
                <Trash2 size={16} aria-hidden /> Remover
              </Button>
            </>
          )
        }
      />
      {error && <Alert kind="danger">{error}</Alert>}
      {['pending', 'processing'].includes(d.status) && (
        <Alert kind="info" title={DOCUMENT_STATUS_LABELS[d.status as 'pending']}>
          O texto está sendo extraído. Esta página é atualizada automaticamente.
        </Alert>
      )}
      {d.status === 'failed' && (
        <Alert kind="danger" title="Falha no processamento">
          {d.errorMessage}
        </Alert>
      )}
      {d.warnings.length > 0 && (
        <Alert kind="warning" title="Avisos do processamento">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {d.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Alert>
      )}
      {processed && d.reviewStatus === 'pending_review' && (
        <Alert kind="warning" title="Aguardando revisão">
          Revise o texto extraído abaixo. O conteúdo só será usado pela pesquisa e pela IA após a aprovação{d.visibility === 'external' ? ' e ficará disponível ao público externo' : ' (somente usuários internos)'}.
        </Alert>
      )}
      <div className="article-layout" style={{ marginTop: 12 }}>
        <section className="card card-body">
          <h2 style={{ fontSize: '1.05rem' }}>Prévia do texto extraído</h2>
          {d.extractedText ? (
            <pre className="diff" style={{ fontFamily: 'inherit', maxHeight: 640 }}>{d.extractedText}</pre>
          ) : (
            <Empty title="Sem texto extraído." />
          )}
        </section>
        <aside className="card card-body">
          <dl className="detail-list">
            <dt>Arquivo</dt>
            <dd>{d.file.name}</dd>
            <dt>Tamanho</dt>
            <dd>{formatBytes(d.file.size)}</dd>
            {d.pageCount && (
              <>
                <dt>Páginas</dt>
                <dd>{d.pageCount}</dd>
              </>
            )}
            <dt>Caracteres</dt>
            <dd>{d.characters.toLocaleString('pt-BR')}</dd>
            <dt>Categoria</dt>
            <dd>{d.category?.name ?? '—'}</dd>
            <dt>Sistema</dt>
            <dd>{d.system?.name ?? '—'}</dd>
            <dt>Palavras-chave</dt>
            <dd>{d.keywords.join(', ') || '—'}</dd>
            <dt>Enviado por</dt>
            <dd>{d.uploadedBy}</dd>
            <dt>Envio</dt>
            <dd>{formatDateTime(d.createdAt)}</dd>
            <dt>Processado</dt>
            <dd>{d.processedAt ? formatDateTime(d.processedAt) : '—'}</dd>
            <dt>Tentativas</dt>
            <dd>{d.attempts}</dd>
            <dt>Revisado por</dt>
            <dd>{d.reviewedBy ? `${d.reviewedBy} em ${formatDateTime(d.reviewedAt)}` : '—'}</dd>
          </dl>
          {d.relatedArticles.length > 0 && (
            <>
              <h3 className="small" style={{ marginTop: 16 }}>
                Artigos relacionados
              </h3>
              <ul className="small">
                {d.relatedArticles.map((a) => (
                  <li key={a.id}>
                    <Link to={`/artigos/${a.slug}`}>{a.title}</Link> {a.status && <StatusBadge status={a.status} />}
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      </div>

      {editMeta && (
        <Modal
          title="Classificação do documento"
          onClose={() => setEditMeta(null)}
          footer={
            <>
              <Button onClick={() => setEditMeta(null)}>Cancelar</Button>
              <Button
                variant="primary"
                onClick={async () => {
                  try {
                    const res = await put<{ requiresNewReview: boolean }>(`/api/documents/${id}`, { ...editMeta, categoryId: editMeta.categoryId || null, systemId: editMeta.systemId || null });
                    toast(res.requiresNewReview ? 'info' : 'success', res.requiresNewReview ? 'Classificação salva. O documento precisa ser revisado novamente para uso externo.' : 'Classificação salva.');
                    setEditMeta(null);
                    await refresh();
                  } catch (err) {
                    setError(errorMessage(err));
                    setEditMeta(null);
                  }
                }}
              >
                Salvar
              </Button>
            </>
          }
        >
          <div className="stack">
            <Field label="Título" htmlFor="dm-title" required>
              <input id="dm-title" className="input" value={editMeta.title} onChange={(e) => setEditMeta({ ...editMeta, title: e.target.value })} />
            </Field>
            <Field label="Visibilidade" required>
              <div className="segmented" role="group" aria-label="Visibilidade">
                {(['internal', 'external'] as const).map((v) => (
                  <button key={v} type="button" aria-pressed={editMeta.visibility === v} onClick={() => setEditMeta({ ...editMeta, visibility: v })}>
                    {VISIBILITY_LABELS[v]}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Categoria" htmlFor="dm-cat">
              <select id="dm-cat" className="select" value={editMeta.categoryId} onChange={(e) => setEditMeta({ ...editMeta, categoryId: e.target.value })}>
                <option value="">—</option>
                {taxonomy.data?.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Sistema" htmlFor="dm-sys">
              <select id="dm-sys" className="select" value={editMeta.systemId} onChange={(e) => setEditMeta({ ...editMeta, systemId: e.target.value })}>
                <option value="">—</option>
                {taxonomy.data?.systems.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Palavras-chave" htmlFor="dm-kw">
              <TagInput id="dm-kw" value={editMeta.keywords} onChange={(v) => setEditMeta({ ...editMeta, keywords: v })} />
            </Field>
          </div>
        </Modal>
      )}
      {confirm === 'remove' && (
        <ConfirmDialog
          title="Remover documento"
          message="O documento deixará de ser usado pela pesquisa e pela IA e o arquivo será apagado. O registro é mantido para rastreabilidade."
          requireReason
          reasonLabel="Motivo da remoção"
          minReason={3}
          confirmLabel="Remover"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={async (reason) => {
            try {
              await del(`/api/documents/${id}`, { reason });
              toast('success', 'Documento removido.');
              navigate('/interno/documentos');
            } catch (err) {
              throw new Error(errorMessage(err));
            }
          }}
        />
      )}
      {confirm === 'reprocess' && (
        <ConfirmDialog
          title="Reprocessar documento"
          message="O texto será extraído novamente e o documento voltará para revisão antes de ser disponibilizado."
          confirmLabel="Reprocessar"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            await action(() => post(`/api/documents/${id}/reprocess`), 'Reprocessamento iniciado.');
            setConfirm(null);
          }}
        />
      )}
      {confirm === 'reject' && (
        <ConfirmDialog
          title="Rejeitar documento"
          message="O documento não será utilizado pela pesquisa nem pela IA."
          confirmLabel="Rejeitar"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            await action(() => post(`/api/documents/${id}/reject`), 'Documento rejeitado.');
            setConfirm(null);
          }}
        />
      )}
    </div>
  );
}

/** Visualização de documento aprovado (pública ou interna, conforme a visibilidade). */
export function DocumentViewPage() {
  const { id = '' } = useParams();
  const doc = useQuery({ queryKey: ['document-view', id], queryFn: () => get<{ document: DocumentItem }>(`/api/documents/${id}`).then((r) => r.document) });
  if (doc.isLoading) return <Spinner />;
  if (!doc.data)
    return (
      <div className="page page-narrow">
        <Empty title="Documento não encontrado ou não disponível." />
      </div>
    );
  const d = doc.data;
  return (
    <div className="page page-narrow">
      <h1>{d.title}</h1>
      <p className="row" style={{ gap: 8 }}>
        {d.system && <span className="badge">{d.system.name}</span>}
        {d.category && <span className="badge">{d.category.name}</span>}
        <a className="btn btn-sm" href={d.file.url}>
          <Download size={14} aria-hidden /> Baixar original ({formatBytes(d.file.size)})
        </a>
      </p>
      <div className="card card-body">
        <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0 }}>{d.extractedText}</pre>
      </div>
    </div>
  );
}
