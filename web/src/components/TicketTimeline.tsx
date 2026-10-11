import { ArrowRightLeft, CheckCircle2, FileText, Link2, Lock, MessageSquare, PlusCircle, RotateCcw, UserCheck, HelpCircle, Wrench } from 'lucide-react';
import { TICKET_MESSAGE_KIND_LABELS, TICKET_STATUS_LABELS, type TicketMessageKind, type TicketStatus } from '@shared/domain';
import { formatDateTime } from '../lib/format';
import type { TimelineEntry, UploadedFile } from '../lib/types';
import { useMedia } from './content/MediaContext';

function Attachments({ files }: { files?: UploadedFile[] }) {
  const media = useMedia();
  if (!files?.length) return null;
  return (
    <div className="attachments">
      {files.map((f) =>
        f.kind === 'image' ? (
          <button key={f.id} type="button" className="attachment-thumb" onClick={() => media.open({ kind: 'image', src: f.url, alt: f.name })} aria-label={`Ampliar ${f.name}`}>
            <img src={f.thumbnailUrl ?? f.url} alt="" loading="lazy" />
            <span>{f.name}</span>
          </button>
        ) : f.kind === 'video' ? (
          <button key={f.id} type="button" className="attachment-thumb" onClick={() => media.open({ kind: 'upload', src: f.url, poster: f.thumbnailUrl, title: f.name })} aria-label={`Reproduzir ${f.name}`}>
            {f.thumbnailUrl ? <img src={f.thumbnailUrl} alt="" loading="lazy" /> : <div style={{ height: 80, background: '#000' }} />}
            <span>▶ {f.name}</span>
          </button>
        ) : (
          <a key={f.id} className="attachment-thumb" href={`${f.url}?download=1`} download={f.name}>
            <div style={{ height: 80, display: 'grid', placeItems: 'center' }}>
              <FileText size={28} aria-hidden />
            </div>
            <span>{f.name}</span>
          </a>
        ),
      )}
    </div>
  );
}

function eventText(e: TimelineEntry): string {
  switch (e.eventType) {
    case 'created':
      return `Ticket aberto (protocolo ${String(e.data?.protocol ?? '')})`;
    case 'status_change': {
      const reason = e.data?.reason ? ` — ${String(e.data.reason)}` : '';
      return `Status alterado de "${TICKET_STATUS_LABELS[e.from as TicketStatus] ?? e.from}" para "${TICKET_STATUS_LABELS[e.to as TicketStatus] ?? e.to}"${reason}`;
    }
    case 'assignment':
      return e.data?.assignee ? `Atendimento atribuído a ${String(e.data.assignee)}` : 'Responsável pelo atendimento removido';
    case 'reopened':
      return `Reabertura solicitada: ${String(e.data?.reason ?? '')}`;
    case 'article_linked':
      return `Artigo relacionado: ${String(e.data?.title ?? '')}`;
    case 'article_unlinked':
      return 'Vínculo com artigo removido';
    case 'classification':
      return 'Classificação do ticket atualizada (prioridade, tipo, categoria ou sistema)';
    case 'resolution_updated':
      return 'Registro de análise/solução atualizado';
    case 'article_suggested':
      return 'Rascunho de artigo sugerido a partir da solução';
    default:
      return e.eventType ?? 'Atualização';
  }
}

function eventIcon(e: TimelineEntry) {
  switch (e.eventType) {
    case 'created':
      return <PlusCircle size={14} aria-hidden />;
    case 'status_change':
      return <ArrowRightLeft size={14} aria-hidden />;
    case 'assignment':
      return <UserCheck size={14} aria-hidden />;
    case 'reopened':
      return <RotateCcw size={14} aria-hidden />;
    case 'article_linked':
      return <Link2 size={14} aria-hidden />;
    default:
      return <Wrench size={14} aria-hidden />;
  }
}

/** Histórico do atendimento em ordem cronológica, com autor, data e hora de cada registro. */
export function TicketTimeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <ol className="timeline" aria-label="Histórico do atendimento">
      {entries.map((e) => {
        if (e.type === 'event') {
          return (
            <li key={e.id} className="timeline-item">
              <span className="timeline-dot" aria-hidden>
                {eventIcon(e)}
              </span>
              <div className="timeline-event">
                {eventText(e)} {e.internal && <span className="badge badge-purple">Interno</span>}
                <div className="tiny">
                  {e.author.name} · {formatDateTime(e.createdAt)}
                </div>
              </div>
            </li>
          );
        }
        const kind = e.kind as TicketMessageKind | undefined;
        const cls =
          e.type === 'internal_note'
            ? 'internal'
            : kind === 'solution'
              ? 'solution'
              : kind === 'info_request'
                ? 'info-request'
                : e.author.role === 'support'
                  ? 'support'
                  : '';
        const label =
          e.type === 'opened'
            ? 'Descrição original'
            : e.type === 'internal_note'
              ? 'Observação interna (não visível ao cliente)'
              : kind
                ? TICKET_MESSAGE_KIND_LABELS[kind]
                : 'Mensagem';
        const Icon = e.type === 'internal_note' ? Lock : kind === 'solution' ? CheckCircle2 : kind === 'info_request' ? HelpCircle : MessageSquare;
        return (
          <li key={e.id} className="timeline-item">
            <span className="timeline-dot" aria-hidden>
              <Icon size={14} />
            </span>
            <div className={`timeline-card ${cls}`}>
              <div className="timeline-head">
                <strong>{e.author.name}</strong>
                <span className="badge">{label}</span>
                <span className="muted tiny">{formatDateTime(e.createdAt)}</span>
              </div>
              <div className="timeline-body">{e.body}</div>
              <Attachments files={e.files} />
            </div>
          </li>
        );
      })}
    </ol>
  );
}
