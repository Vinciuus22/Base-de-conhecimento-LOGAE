import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { diffWords } from 'diff';
import { ArrowLeft, GitCompare, RotateCcw } from 'lucide-react';
import { ARTICLE_OPERATION_LABELS, ARTICLE_OPERATIONS, VISIBILITY_LABELS, ARTICLE_STATUS_LABELS, type ArticleOperation } from '@shared/domain';
import { get, post, qs, errorMessage } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { PageHeader } from '../../components/Layout';
import { Alert, Button, ConfirmDialog, Empty, Field, Pagination, Spinner, StatusBadge, useToast } from '../../components/ui';

interface HistoryItem {
  id: number;
  operation: ArticleOperation;
  version: number;
  changes: Record<string, { before: unknown; after: unknown } | unknown>;
  summary: string | null;
  result: 'success' | 'failure';
  createdAt: string;
  user: { id: string; name: string };
}

interface VersionSnapshot {
  version: number;
  title: string;
  summary: string;
  contentText: string;
  category: string | null;
  system: string | null;
  keywords: string[];
  tags: string[];
  status: string;
  visibility: string;
  createdAt: string;
  createdBy: string;
}

const FIELD_LABELS: Record<string, string> = {
  title: 'Título',
  summary: 'Resumo',
  content: 'Conteúdo',
  category: 'Categoria',
  system: 'Sistema',
  keywords: 'Palavras-chave',
  tags: 'Tags',
  visibility: 'Visibilidade',
  status: 'Status',
  restoredFrom: 'Versão restaurada',
  reason: 'Motivo',
  expectedVersion: 'Versão editada',
};

function show(field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (field === 'visibility') return VISIBILITY_LABELS[v as 'internal'] ?? String(v);
  if (field === 'status') return ARTICLE_STATUS_LABELS[v as 'draft'] ?? String(v);
  if (Array.isArray(v)) return v.join(', ') || '—';
  if (typeof v === 'object') return 'characters' in (v as object) ? `${(v as { characters: number }).characters} caracteres` : JSON.stringify(v);
  return String(v);
}

function Diff({ before, after }: { before: string; after: string }) {
  const parts = diffWords(before, after);
  return (
    <div className="diff" aria-label="Comparação de conteúdo">
      {parts.map((p, i) => (p.added ? <ins key={i}>{p.value}</ins> : p.removed ? <del key={i}>{p.value}</del> : <span key={i}>{p.value}</span>))}
    </div>
  );
}

export function ArticleHistoryPage() {
  const { id = '' } = useParams();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState({ user: '', operation: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const [compare, setCompare] = useState<{ a: number; b: number } | null>(null);
  const [restore, setRestore] = useState<number | null>(null);

  const history = useQuery({
    queryKey: ['history', id, filters, page],
    queryFn: () =>
      get<{ article: { id: string; title: string; slug: string; version: number; status: string }; total: number; users: Array<{ id: string; name: string }>; items: HistoryItem[] }>(
        `/api/articles/${id}/history${qs({ ...filters, page, pageSize: 20 })}`,
      ),
  });
  const versions = useQuery({ queryKey: ['versions', id], queryFn: () => get<{ items: Array<{ version: number; title: string; createdAt: string; createdBy: string; status: string }> }>(`/api/articles/${id}/versions`) });
  const left = useQuery({ queryKey: ['version', id, compare?.a], queryFn: () => get<{ version: VersionSnapshot }>(`/api/articles/${id}/versions/${compare!.a}`), enabled: !!compare });
  const right = useQuery({ queryKey: ['version', id, compare?.b], queryFn: () => get<{ version: VersionSnapshot }>(`/api/articles/${id}/versions/${compare!.b}`), enabled: !!compare });

  if (history.isLoading) return <Spinner />;
  if (history.isError || !history.data) return <div className="page"><Alert kind="danger">{errorMessage(history.error)}</Alert></div>;
  const { article, items, total, users } = history.data;
  const versionList = versions.data?.items ?? [];

  const setFilter = (k: keyof typeof filters, v: string) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  };

  return (
    <div className="page">
      <PageHeader
        title="Histórico de alterações"
        subtitle={
          <>
            <Link to={`/artigos/${article.slug}`}>{article.title}</Link> · versão atual {article.version} · <StatusBadge status={article.status} />
          </>
        }
        actions={
          <Link className="btn" to={`/artigos/${article.slug}`}>
            <ArrowLeft size={16} aria-hidden /> Voltar ao artigo
          </Link>
        }
      />

      <div className="card card-body" style={{ marginBottom: 16 }}>
        <div className="grid grid-4">
          <Field label="Usuário" htmlFor="h-user">
            <select id="h-user" className="select" value={filters.user} onChange={(e) => setFilter('user', e.target.value)}>
              <option value="">Todos</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tipo de operação" htmlFor="h-op">
            <select id="h-op" className="select" value={filters.operation} onChange={(e) => setFilter('operation', e.target.value)}>
              <option value="">Todas</option>
              {ARTICLE_OPERATIONS.map((o) => (
                <option key={o} value={o}>
                  {ARTICLE_OPERATION_LABELS[o]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="De" htmlFor="h-from">
            <input id="h-from" type="date" className="input" value={filters.from} onChange={(e) => setFilter('from', e.target.value)} />
          </Field>
          <Field label="Até" htmlFor="h-to">
            <input id="h-to" type="date" className="input" value={filters.to} onChange={(e) => setFilter('to', e.target.value)} />
          </Field>
        </div>
      </div>

      {versionList.length > 1 && (
        <div className="card card-body" style={{ marginBottom: 16 }}>
          <div className="row">
            <GitCompare size={18} aria-hidden />
            <strong>Comparar versões</strong>
            <select className="select" style={{ width: 'auto' }} aria-label="Versão anterior" value={compare?.a ?? versionList[1]!.version} onChange={(e) => setCompare({ a: Number(e.target.value), b: compare?.b ?? versionList[0]!.version })}>
              {versionList.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version} — {formatDateTime(v.createdAt)}
                </option>
              ))}
            </select>
            <span>com</span>
            <select className="select" style={{ width: 'auto' }} aria-label="Versão posterior" value={compare?.b ?? versionList[0]!.version} onChange={(e) => setCompare({ a: compare?.a ?? versionList[1]!.version, b: Number(e.target.value) })}>
              {versionList.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version} — {formatDateTime(v.createdAt)}
                </option>
              ))}
            </select>
            {!compare && (
              <Button size="sm" onClick={() => setCompare({ a: versionList[1]!.version, b: versionList[0]!.version })}>
                Comparar
              </Button>
            )}
          </div>
          {compare && left.data && right.data && (
            <div className="stack" style={{ marginTop: 16 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Campo</th>
                    <th>Versão {compare.a}</th>
                    <th>Versão {compare.b}</th>
                  </tr>
                </thead>
                <tbody>
                  {(['title', 'summary', 'category', 'system', 'keywords', 'tags', 'visibility', 'status'] as const).map((f) => {
                    const a = show(f, left.data.version[f]);
                    const b = show(f, right.data.version[f]);
                    return (
                      <tr key={f} style={a !== b ? { background: '#fffbea' } : undefined}>
                        <td>{FIELD_LABELS[f]}</td>
                        <td>{a}</td>
                        <td>{b}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <strong>Conteúdo</strong>
              <Diff before={left.data.version.contentText} after={right.data.version.contentText} />
              <p className="tiny muted">
                <ins style={{ background: '#d1fadf', textDecoration: 'none' }}>Texto adicionado</ins> · <del style={{ background: '#fde2e2' }}>texto removido</del>
              </p>
            </div>
          )}
        </div>
      )}

      <section className="card" aria-label="Eventos">
        {items.length === 0 ? (
          <Empty title="Nenhum registro encontrado para os filtros." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Data e hora</th>
                  <th>Responsável</th>
                  <th>Alteração</th>
                  <th>Versão</th>
                  <th>Resumo das mudanças</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((h) => (
                  <tr key={h.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(h.createdAt)}</td>
                    <td>{h.user.name}</td>
                    <td>
                      <span className={`badge ${h.result === 'failure' ? 'badge-danger' : ''}`}>{ARTICLE_OPERATION_LABELS[h.operation] ?? h.operation}</span>
                    </td>
                    <td>v{h.version}</td>
                    <td>
                      <div>{h.summary}</div>
                      <ul className="tiny muted" style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                        {Object.entries(h.changes).map(([field, change]) => {
                          const c = change as { before?: unknown; after?: unknown };
                          return (
                            <li key={field}>
                              <strong>{FIELD_LABELS[field] ?? field}:</strong>{' '}
                              {c && typeof c === 'object' && 'after' in c ? (
                                <>
                                  {show(field, c.before)} → {show(field, c.after)}
                                </>
                              ) : (
                                show(field, change)
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </td>
                    <td>
                      {h.result === 'success' && h.version < article.version && versionList.some((v) => v.version === h.version) && (
                        <Button size="sm" onClick={() => setRestore(h.version)}>
                          <RotateCcw size={14} aria-hidden /> Restaurar v{h.version}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <Pagination page={page} pageSize={20} total={total} onChange={setPage} />

      {restore !== null && (
        <ConfirmDialog
          title={`Restaurar a versão ${restore}?`}
          message="O conteúdo da versão selecionada será restaurado como uma NOVA versão. Nenhum registro anterior será apagado."
          confirmLabel="Restaurar"
          onCancel={() => setRestore(null)}
          onConfirm={async () => {
            try {
              await post(`/api/articles/${id}/versions/${restore}/restore`, { expectedVersion: article.version });
              toast('success', `Versão ${restore} restaurada.`);
              setRestore(null);
              await queryClient.invalidateQueries({ queryKey: ['history', id] });
              await queryClient.invalidateQueries({ queryKey: ['versions', id] });
            } catch (err) {
              throw new Error(errorMessage(err));
            }
          }}
        />
      )}
    </div>
  );
}
