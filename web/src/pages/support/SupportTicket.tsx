import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FilePlus2, Lock, Link2, Send, Trash2, UserCheck, X } from 'lucide-react';
import {
  SUPPORT_STATUS_TRANSITIONS,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_REQUEST_TYPES,
  TICKET_REQUEST_TYPE_LABELS,
  TICKET_STATUS_LABELS,
  type TicketStatus,
} from '@shared/domain';
import { del, errorMessage, get, post, put, qs, upload } from '../../lib/api';
import type { Taxonomy, TicketDetail } from '../../lib/types';
import { useAuth } from '../../context/AuthContext';
import { TicketTimeline } from '../../components/TicketTimeline';
import { TicketFacts } from '../tickets/TicketDetail';
import { Alert, Button, Empty, Field, FileDropzone, Spinner, StatusBadge, useToast } from '../../components/ui';

export function SupportTicketPage() {
  const { id = '' } = useParams();
  const { user, can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: t, isLoading, error } = useQuery({
    queryKey: ['ticket', id, 'support'],
    queryFn: () => get<{ ticket: TicketDetail }>(`/api/tickets/${id}?as=support`).then((r) => r.ticket),
    refetchInterval: 30_000,
  });
  const taxonomy = useQuery({ queryKey: ['taxonomy'], queryFn: () => get<Taxonomy>('/api/taxonomy') });
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => get<{ items: Array<{ id: string; name: string }> }>('/api/users/agents'), enabled: can('tickets.manage') });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['ticket', id] });

  const [tab, setTab] = useState<'reply' | 'note' | 'resolution' | 'classification'>('reply');
  const [reply, setReply] = useState('');
  const [replyKind, setReplyKind] = useState<'support_reply' | 'info_request'>('support_reply');
  const [replyFiles, setReplyFiles] = useState<File[]>([]);
  const [note, setNote] = useState('');
  const [noteFiles, setNoteFiles] = useState<File[]>([]);
  const [resolution, setResolution] = useState({ analysisResult: '', procedures: '', solution: '', guidance: '' });
  const [cls, setCls] = useState({ priority: 'medium', requestType: 'incident', categoryId: '', systemId: '', title: '' });
  const [statusTo, setStatusTo] = useState('');
  const [statusReason, setStatusReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pickerQ, setPickerQ] = useState('');

  useEffect(() => {
    if (!t) return;
    setResolution({ analysisResult: t.analysisResult ?? '', procedures: t.procedures ?? '', solution: t.solution ?? '', guidance: t.guidance ?? '' });
    setCls({ priority: t.priority, requestType: t.requestType, categoryId: t.category?.id ?? '', systemId: t.system.id, title: t.title });
  }, [t?.id, t?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const picker = useQuery({
    queryKey: ['article-picker', pickerQ],
    queryFn: () => get<{ items: Array<{ id: string; title: string; visibility: string }> }>(`/api/support/article-picker${qs({ q: pickerQ })}`),
    enabled: pickerQ.length >= 2,
  });

  if (isLoading) return <Spinner />;
  if (error || !t) {
    return (
      <div className="page">
        <Empty title="Ticket não encontrado ou não autorizado">
          <p>{errorMessage(error)}</p>
          <Link className="btn" to="/interno/tickets">
            Voltar à fila
          </Link>
        </Empty>
      </div>
    );
  }

  const run = async (key: string, fn: () => Promise<unknown>, success: string) => {
    setErr(null);
    setBusy(key);
    try {
      await fn();
      toast('success', success);
      await refresh();
      return true;
    } catch (e) {
      setErr(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const transitions = SUPPORT_STATUS_TRANSITIONS[t.status as TicketStatus] ?? [];
  const canSupport = t.permissions.canSupport;

  return (
    <div className="page" style={{ maxWidth: 1320 }}>
      <div className="page-header">
        <div>
          <Link to="/interno/tickets" className="small">
            <ArrowLeft size={14} aria-hidden style={{ verticalAlign: 'middle' }} /> Fila de atendimento
          </Link>
          <h1 style={{ marginTop: 6 }}>{t.title}</h1>
          <p className="row" style={{ gap: 8 }}>
            Protocolo <strong>{t.protocol}</strong> <StatusBadge status={t.status} /> <StatusBadge status={t.priority} />
            <span className="small">Solicitante: {t.requester.name} ({t.requester.email})</span>
          </p>
        </div>
        <div className="btn-group">
          {!t.assignee && canSupport && (
            <Button onClick={() => run('assign', () => post(`/api/support/tickets/${t.id}/assign`, { assigneeId: user!.id }), 'Ticket assumido.')} loading={busy === 'assign'}>
              <UserCheck size={16} aria-hidden /> Assumir atendimento
            </Button>
          )}
          {can('tickets.manage') && (
            <select
              className="select"
              style={{ width: 'auto' }}
              aria-label="Atribuir a"
              value={t.assignee?.id ?? ''}
              onChange={(e) => run('assign', () => post(`/api/support/tickets/${t.id}/assign`, { assigneeId: e.target.value || null }), 'Responsável atualizado.')}
            >
              <option value="">Sem responsável</option>
              {agents.data?.items.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      {err && <Alert kind="danger">{err}</Alert>}

      <div className="article-layout" style={{ marginTop: 12 }}>
        <div className="stack" style={{ gap: 20 }}>
          <section>
            <h2 style={{ fontSize: '1.15rem' }}>Histórico completo</h2>
            <TicketTimeline entries={t.timeline} />
          </section>

          {canSupport && (
            <section className="card card-body">
              <div className="tabs" role="tablist">
                {(
                  [
                    ['reply', 'Responder ao cliente'],
                    ['note', 'Observação interna'],
                    ['resolution', 'Análise e solução'],
                    ['classification', 'Classificação'],
                  ] as const
                ).map(([k, label]) => (
                  <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
                    {label}
                  </button>
                ))}
              </div>

              {tab === 'reply' && (
                <div className="stack">
                  <div className="segmented" role="group" aria-label="Tipo de resposta">
                    <button type="button" aria-pressed={replyKind === 'support_reply'} onClick={() => setReplyKind('support_reply')}>
                      Resposta
                    </button>
                    <button type="button" aria-pressed={replyKind === 'info_request'} onClick={() => setReplyKind('info_request')}>
                      Solicitar informações
                    </button>
                  </div>
                  {replyKind === 'info_request' && <p className="small muted" style={{ margin: 0 }}>O status mudará para “Aguardando usuário”.</p>}
                  <Field label="Mensagem visível ao cliente" htmlFor="sup-reply">
                    <textarea id="sup-reply" className="textarea" value={reply} onChange={(e) => setReply(e.target.value)} />
                  </Field>
                  <FileDropzone files={replyFiles} onChange={setReplyFiles} accept="image/*,video/*,application/pdf,.docx,.xlsx,.zip,.txt,.csv" label="Anexos (opcional)" />
                  <div className="btn-group" style={{ justifyContent: 'flex-end' }}>
                    <Button
                      variant="primary"
                      loading={busy === 'reply'}
                      disabled={!reply.trim() || t.status === 'closed'}
                      onClick={async () => {
                        const form = new FormData();
                        form.append('body', reply);
                        form.append('kind', replyKind);
                        for (const f of replyFiles) form.append('files', f, f.name);
                        if (await run('reply', () => upload(`/api/support/tickets/${t.id}/reply`, form), 'Resposta enviada ao cliente.')) {
                          setReply('');
                          setReplyFiles([]);
                        }
                      }}
                    >
                      <Send size={16} aria-hidden /> Enviar ao cliente
                    </Button>
                  </div>
                </div>
              )}

              {tab === 'note' && (
                <div className="stack">
                  <Alert kind="warning">
                    <Lock size={14} aria-hidden style={{ verticalAlign: 'middle' }} /> Observações internas nunca são exibidas ao cliente.
                  </Alert>
                  <Field label="Observação interna" htmlFor="sup-note">
                    <textarea id="sup-note" className="textarea" value={note} onChange={(e) => setNote(e.target.value)} />
                  </Field>
                  <FileDropzone files={noteFiles} onChange={setNoteFiles} accept="image/*,video/*,application/pdf,.docx,.xlsx,.zip,.txt,.csv" label="Anexos internos (opcional)" />
                  <div className="btn-group" style={{ justifyContent: 'flex-end' }}>
                    <Button
                      loading={busy === 'note'}
                      disabled={!note.trim()}
                      onClick={async () => {
                        const form = new FormData();
                        form.append('body', note);
                        for (const f of noteFiles) form.append('files', f, f.name);
                        if (await run('note', () => upload(`/api/support/tickets/${t.id}/notes`, form), 'Observação interna registrada.')) {
                          setNote('');
                          setNoteFiles([]);
                        }
                      }}
                    >
                      Registrar observação
                    </Button>
                  </div>
                </div>
              )}

              {tab === 'resolution' && (
                <div className="stack">
                  <p className="small muted" style={{ margin: 0 }}>Estas informações ficam visíveis ao cliente para que ele compreenda a análise e a solução.</p>
                  {(
                    [
                      ['analysisResult', 'Resultado da análise'],
                      ['procedures', 'Procedimentos executados'],
                      ['solution', 'Solução aplicada'],
                      ['guidance', 'Orientações complementares'],
                    ] as const
                  ).map(([k, label]) => (
                    <Field key={k} label={label} htmlFor={`res-${k}`} required={k === 'solution'}>
                      <textarea id={`res-${k}`} className="textarea" style={{ minHeight: 80 }} value={resolution[k]} onChange={(e) => setResolution((r) => ({ ...r, [k]: e.target.value }))} />
                    </Field>
                  ))}
                  <div className="btn-group" style={{ justifyContent: 'flex-end' }}>
                    <Button loading={busy === 'resolution'} onClick={() => run('resolution', () => put(`/api/support/tickets/${t.id}/resolution`, { ...resolution, resolve: false }), 'Registro salvo.')}>
                      Salvar registro
                    </Button>
                    {transitions.includes('resolved') && (
                      <Button
                        variant="primary"
                        loading={busy === 'resolve'}
                        disabled={!resolution.solution.trim()}
                        onClick={() => run('resolve', () => put(`/api/support/tickets/${t.id}/resolution`, { ...resolution, resolve: true }), 'Ticket resolvido e solução enviada ao cliente.')}
                      >
                        Salvar e marcar como resolvido
                      </Button>
                    )}
                    {can('articles.create') && t.solution && (
                      <Button
                        loading={busy === 'suggest'}
                        onClick={async () => {
                          setBusy('suggest');
                          try {
                            const res = await post<{ article: { id: string } }>(`/api/support/tickets/${t.id}/suggest-article`);
                            toast('success', 'Rascunho de artigo criado a partir da solução.');
                            navigate(`/interno/artigos/${res.article.id}/editar`);
                          } catch (e) {
                            setErr(errorMessage(e));
                          } finally {
                            setBusy(null);
                          }
                        }}
                      >
                        <FilePlus2 size={16} aria-hidden /> Sugerir artigo
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {tab === 'classification' && (
                <div className="grid grid-2">
                  <Field label="Título" htmlFor="cls-title">
                    <input id="cls-title" className="input" value={cls.title} onChange={(e) => setCls((c) => ({ ...c, title: e.target.value }))} />
                  </Field>
                  <Field label="Prioridade" htmlFor="cls-prio">
                    <select id="cls-prio" className="select" value={cls.priority} onChange={(e) => setCls((c) => ({ ...c, priority: e.target.value }))}>
                      {TICKET_PRIORITIES.map((p) => (
                        <option key={p} value={p}>
                          {TICKET_PRIORITY_LABELS[p]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Tipo" htmlFor="cls-type">
                    <select id="cls-type" className="select" value={cls.requestType} onChange={(e) => setCls((c) => ({ ...c, requestType: e.target.value }))}>
                      {TICKET_REQUEST_TYPES.map((p) => (
                        <option key={p} value={p}>
                          {TICKET_REQUEST_TYPE_LABELS[p]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Categoria" htmlFor="cls-cat">
                    <select id="cls-cat" className="select" value={cls.categoryId} onChange={(e) => setCls((c) => ({ ...c, categoryId: e.target.value }))}>
                      <option value="">—</option>
                      {taxonomy.data?.categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Sistema" htmlFor="cls-sys">
                    <select id="cls-sys" className="select" value={cls.systemId} onChange={(e) => setCls((c) => ({ ...c, systemId: e.target.value }))}>
                      {taxonomy.data?.systems.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div style={{ alignSelf: 'end' }}>
                    <Button loading={busy === 'cls'} onClick={() => run('cls', () => put(`/api/support/tickets/${t.id}/classification`, { ...cls, categoryId: cls.categoryId || null }), 'Classificação atualizada.')}>
                      Salvar classificação
                    </Button>
                  </div>
                </div>
              )}
            </section>
          )}
        </div>

        <aside className="stack">
          <div className="card card-body">
            <TicketFacts t={t} />
          </div>
          {canSupport && transitions.length > 0 && (
            <div className="card card-body stack">
              <strong>Alterar status</strong>
              <select className="select" aria-label="Novo status" value={statusTo} onChange={(e) => setStatusTo(e.target.value)}>
                <option value="">Selecione…</option>
                {transitions.map((s) => (
                  <option key={s} value={s}>
                    {TICKET_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
              <textarea className="textarea" style={{ minHeight: 60 }} placeholder="Motivo (obrigatório ao fechar sem resolução)" aria-label="Motivo" value={statusReason} onChange={(e) => setStatusReason(e.target.value)} />
              <Button
                disabled={!statusTo}
                loading={busy === 'status'}
                onClick={async () => {
                  if (await run('status', () => post(`/api/support/tickets/${t.id}/status`, { status: statusTo, reason: statusReason || undefined }), 'Status atualizado.')) {
                    setStatusTo('');
                    setStatusReason('');
                  }
                }}
              >
                Aplicar
              </Button>
            </div>
          )}
          <div className="card card-body stack">
            <strong>Artigos relacionados</strong>
            {t.relatedArticles.length === 0 && <span className="small muted">Nenhum artigo vinculado.</span>}
            {t.relatedArticles.map((a) => (
              <div key={a.id} className="row" style={{ gap: 6 }}>
                <Link to={`/artigos/${a.slug}`} className="small" style={{ flex: 1 }}>
                  {a.title}
                </Link>
                {canSupport && (
                  <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label={`Desvincular ${a.title}`} onClick={() => run('unlink', () => del(`/api/support/tickets/${t.id}/articles/${a.id}`), 'Vínculo removido.')}>
                    <Trash2 size={14} aria-hidden />
                  </button>
                )}
              </div>
            ))}
            {canSupport && (
              <>
                <input className="input" placeholder="Buscar artigo para vincular…" aria-label="Buscar artigo" value={pickerQ} onChange={(e) => setPickerQ(e.target.value)} />
                {picker.data?.items.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className="btn btn-sm"
                    style={{ justifyContent: 'flex-start', whiteSpace: 'normal', textAlign: 'left' }}
                    onClick={() => run('link', () => post(`/api/support/tickets/${t.id}/articles`, { articleId: a.id }), 'Artigo vinculado.').then(() => setPickerQ(''))}
                  >
                    <Link2 size={14} aria-hidden /> {a.title} {a.visibility === 'internal' && <span className="badge badge-purple">Interno</span>}
                  </button>
                ))}
                {pickerQ && (
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPickerQ('')}>
                    <X size={14} aria-hidden /> Limpar
                  </button>
                )}
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
