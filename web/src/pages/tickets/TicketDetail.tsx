import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Newspaper, RotateCcw, Send } from 'lucide-react';
import { TICKET_REQUEST_TYPE_LABELS, TICKET_PRIORITY_LABELS } from '@shared/domain';
import { IMAGE_MIME_TYPES, VIDEO_MIME_TYPES } from '@shared/uploads';
import { errorMessage, get, post, upload } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import type { TicketDetail } from '../../lib/types';
import { useAuth } from '../../context/AuthContext';
import { TicketTimeline } from '../../components/TicketTimeline';
import { Alert, Button, ConfirmDialog, Empty, Field, FileDropzone, Spinner, StatusBadge, useToast } from '../../components/ui';

export function SolutionBox({ t }: { t: TicketDetail }) {
  if (!t.solution && !t.analysisResult && !t.procedures && !t.guidance) return null;
  return (
    <section className="solution-box" aria-label="Resultado do atendimento">
      {t.analysisResult && (
        <>
          <h3>Resultado da análise</h3>
          <p>{t.analysisResult}</p>
        </>
      )}
      {t.procedures && (
        <>
          <h3>Procedimentos executados</h3>
          <p>{t.procedures}</p>
        </>
      )}
      {t.solution && (
        <>
          <h3>Solução aplicada</h3>
          <p>{t.solution}</p>
        </>
      )}
      {t.guidance && (
        <>
          <h3>Orientações complementares</h3>
          <p>{t.guidance}</p>
        </>
      )}
    </section>
  );
}

export function TicketFacts({ t }: { t: TicketDetail }) {
  return (
    <dl className="detail-list">
      <dt>Protocolo</dt>
      <dd>{t.protocol}</dd>
      <dt>Status</dt>
      <dd>
        <StatusBadge status={t.status} />
      </dd>
      <dt>Sistema</dt>
      <dd>{t.system.name}</dd>
      <dt>Empresa</dt>
      <dd>{t.company.name}</dd>
      <dt>Solicitante</dt>
      <dd>{t.requester.name}</dd>
      <dt>Tipo</dt>
      <dd>{TICKET_REQUEST_TYPE_LABELS[t.requestType as 'incident'] ?? t.requestType}</dd>
      {t.category && (
        <>
          <dt>Categoria</dt>
          <dd>{t.category.name}</dd>
        </>
      )}
      <dt>Prioridade</dt>
      <dd>{TICKET_PRIORITY_LABELS[t.priority as 'low'] ?? t.priority}</dd>
      <dt>Responsável</dt>
      <dd>{t.assignee?.name ?? 'Aguardando atribuição'}</dd>
      <dt>Abertura</dt>
      <dd>{formatDateTime(t.createdAt)}</dd>
      <dt>Última atualização</dt>
      <dd>{formatDateTime(t.updatedAt)}</dd>
      {t.resolvedAt && (
        <>
          <dt>Resolução</dt>
          <dd>{formatDateTime(t.resolvedAt)}</dd>
        </>
      )}
      {t.closedAt && (
        <>
          <dt>Fechamento</dt>
          <dd>{formatDateTime(t.closedAt)}</dd>
        </>
      )}
    </dl>
  );
}

export function TicketDetailPage() {
  const { id = '' } = useParams();
  const { config } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmResolved, setConfirmResolved] = useState(false);
  const [reopen, setReopen] = useState(false);

  const { data, isLoading, error: loadError } = useQuery({
    queryKey: ['ticket', id, 'customer'],
    queryFn: () => get<{ ticket: TicketDetail }>(`/api/tickets/${id}?as=customer`).then((r) => r.ticket),
    refetchInterval: 30_000,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['ticket', id] });

  if (isLoading) return <Spinner />;
  if (loadError || !data) {
    return (
      <div className="page page-narrow">
        <Empty title="Ticket não encontrado">
          <p>{errorMessage(loadError)}</p>
          <Link to="/tickets" className="btn">
            <ArrowLeft size={16} aria-hidden /> Meus tickets
          </Link>
        </Empty>
      </div>
    );
  }
  const t = data;
  const closed = t.status === 'closed';

  const send = async () => {
    setError(null);
    if (!message.trim()) return setError('Escreva a mensagem.');
    const form = new FormData();
    form.append('body', message);
    for (const f of files) form.append('files', f, f.name);
    setSending(true);
    try {
      await upload(`/api/tickets/${t.id}/messages`, form);
      setMessage('');
      setFiles([]);
      toast('success', 'Mensagem enviada ao suporte.');
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <Link to="/tickets" className="small">
            <ArrowLeft size={14} aria-hidden style={{ verticalAlign: 'middle' }} /> Meus tickets
          </Link>
          <h1 style={{ marginTop: 6 }}>{t.title}</h1>
          <p className="row" style={{ gap: 8 }}>
            Protocolo <strong>{t.protocol}</strong> <StatusBadge status={t.status} />
          </p>
        </div>
      </div>
      <div className="article-layout">
        <div className="stack" style={{ gap: 20 }}>
          {t.status === 'waiting_user' && (
            <Alert kind="warning" title="O suporte aguarda informações suas">
              Responda abaixo com as informações solicitadas. Você pode anexar imagens ou vídeos.
            </Alert>
          )}
          {t.status === 'resolved' && (
            <Alert kind="success" title="O suporte registrou uma solução">
              Confira a solução e confirme se o problema foi resolvido. Se o problema persistir, solicite a reabertura em até {config?.ticketReopenWindowDays ?? 7} dias.
              <div className="btn-group" style={{ marginTop: 8 }}>
                <Button size="sm" variant="primary" onClick={() => setConfirmResolved(true)}>
                  <CheckCircle2 size={14} aria-hidden /> Confirmar que foi resolvido
                </Button>
                <Button size="sm" onClick={() => setReopen(true)}>
                  <RotateCcw size={14} aria-hidden /> O problema continua
                </Button>
              </div>
            </Alert>
          )}
          <SolutionBox t={t} />
          {t.relatedArticles.length > 0 && (
            <section className="card card-body">
              <strong>Artigos relacionados ao atendimento</strong>
              <ul>
                {t.relatedArticles.map((a) => (
                  <li key={a.id}>
                    <Link to={`/artigos/${a.slug}`}>
                      <Newspaper size={14} aria-hidden style={{ verticalAlign: 'middle' }} /> {a.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h2 style={{ fontSize: '1.15rem' }}>Histórico do atendimento</h2>
            <TicketTimeline entries={t.timeline} />
          </section>
          {!closed ? (
            <section className="card card-body stack" aria-label="Enviar mensagem ao suporte">
              <Field label="Responder ao suporte / enviar informações adicionais" htmlFor="reply">
                <textarea id="reply" className="textarea" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={20000} />
              </Field>
              <FileDropzone files={files} onChange={setFiles} accept={[...IMAGE_MIME_TYPES, ...VIDEO_MIME_TYPES].join(',')} label="Anexar imagens ou vídeos (opcional)" />
              {error && <Alert kind="danger">{error}</Alert>}
              <div className="btn-group" style={{ justifyContent: 'flex-end' }}>
                <Button variant="primary" onClick={send} loading={sending}>
                  <Send size={16} aria-hidden /> Enviar mensagem
                </Button>
              </div>
            </section>
          ) : (
            <Alert kind="info" title="Ticket fechado">
              O histórico permanece disponível para consulta. Se o problema voltou a ocorrer, você pode solicitar a reabertura em até {config?.ticketReopenWindowDays ?? 7} dias após o fechamento ou abrir um novo ticket informando o protocolo {t.protocol}.
              <div style={{ marginTop: 8 }}>
                <Button size="sm" onClick={() => setReopen(true)}>
                  <RotateCcw size={14} aria-hidden /> Solicitar reabertura
                </Button>
              </div>
            </Alert>
          )}
        </div>
        <aside className="card card-body">
          <TicketFacts t={t} />
        </aside>
      </div>

      {confirmResolved && (
        <ConfirmDialog
          title="Confirmar resolução"
          message="O ticket será fechado. O histórico continuará disponível para consulta."
          confirmLabel="Confirmar e fechar"
          onCancel={() => setConfirmResolved(false)}
          onConfirm={async () => {
            try {
              await post(`/api/tickets/${t.id}/confirm-resolution`);
              setConfirmResolved(false);
              toast('success', 'Obrigado! O ticket foi fechado.');
              await refresh();
            } catch (err) {
              throw new Error(errorMessage(err));
            }
          }}
        />
      )}
      {reopen && (
        <ConfirmDialog
          title="Solicitar reabertura"
          message="Explique o que continua acontecendo. O histórico anterior será preservado."
          confirmLabel="Solicitar reabertura"
          requireReason
          reasonLabel="Motivo da reabertura"
          minReason={10}
          onCancel={() => setReopen(false)}
          onConfirm={async (reason) => {
            try {
              await post(`/api/tickets/${t.id}/reopen`, { reason });
              setReopen(false);
              toast('success', 'Reabertura solicitada.');
              await refresh();
            } catch (err) {
              throw new Error(errorMessage(err));
            }
          }}
        />
      )}
    </div>
  );
}
