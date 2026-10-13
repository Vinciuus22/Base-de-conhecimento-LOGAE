import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, Inbox, Upload, X } from 'lucide-react';
import { ARTICLE_STATUS_LABELS, DOCUMENT_REVIEW_LABELS, DOCUMENT_STATUS_LABELS, TICKET_PRIORITY_LABELS, TICKET_STATUS_LABELS, VISIBILITY_LABELS } from '@shared/domain';
import { formatBytes } from '@shared/uploads';

// ---------------------------------------------------------------------------
export function Button({
  variant = 'default',
  size,
  loading,
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'cta' | 'danger' | 'ghost'; size?: 'sm'; loading?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || loading}
      aria-busy={loading || undefined}
      className={`btn ${variant !== 'default' ? `btn-${variant}` : ''} ${size === 'sm' ? 'btn-sm' : ''} ${className}`}
    >
      {loading && <span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} aria-hidden />}
      {children}
    </button>
  );
}

export function Spinner({ label = 'Carregando…' }: { label?: string }) {
  return (
    <div className="loading-block" role="status" aria-live="polite">
      <span className="spinner" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      {icon ?? <Inbox size={36} aria-hidden />}
      <p style={{ fontWeight: 600, color: 'var(--text)', margin: '0 0 4px' }}>{title}</p>
      {children}
    </div>
  );
}

export function Alert({ kind = 'info', title, children }: { kind?: 'info' | 'warning' | 'danger' | 'success'; title?: string; children?: ReactNode }) {
  const Icon = kind === 'danger' ? AlertCircle : kind === 'warning' ? AlertTriangle : kind === 'success' ? CheckCircle2 : Info;
  return (
    <div className={`alert alert-${kind}`} role={kind === 'danger' ? 'alert' : 'status'}>
      <Icon size={18} aria-hidden />
      <div>
        {title && <strong style={{ display: 'block' }}>{title}</strong>}
        {children}
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  required,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor} className={required ? 'required' : undefined}>
        {label}
      </label>
      {children}
      {hint && !error && <span className="hint">{hint}</span>}
      {error && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, select, textarea, button:not([data-close]), [href]');
    (first ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && ref.current) {
        const items = [...ref.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])')];
        if (!items.length) return;
        const firstEl = items[0]!;
        const lastEl = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" data-close className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Fechar">
            <X size={18} aria-hidden />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

/** Confirmação de operações destrutivas ou relevantes, com campo de motivo opcional. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirmar',
  danger,
  requireReason,
  reasonLabel = 'Motivo',
  minReason = 5,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  requireReason?: boolean;
  reasonLabel?: string;
  minReason?: number;
  onConfirm: (reason: string) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha na operação.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Cancelar</Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={busy} disabled={requireReason && reason.trim().length < minReason} onClick={run}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div>{message}</div>
        {requireReason && (
          <Field label={reasonLabel} required hint={`Mínimo de ${minReason} caracteres.`} htmlFor="confirm-reason">
            <textarea id="confirm-reason" className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}
        {error && <Alert kind="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  text: string;
}
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-region" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            {t.kind === 'success' ? <CheckCircle2 size={18} aria-hidden /> : t.kind === 'error' ? <AlertCircle size={18} aria-hidden /> : <Info size={18} aria-hidden />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------------------------------------------------------------------------
export function Pagination({ page, pageSize, total, onChange }: { page: number; pageSize: number; total: number; onChange: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <nav className="pagination" aria-label="Paginação">
      <Button size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        Anterior
      </Button>
      <span className="small muted">
        Página {page} de {pages}
      </span>
      <Button size="sm" disabled={page >= pages} onClick={() => onChange(page + 1)}>
        Próxima
      </Button>
    </nav>
  );
}

export function TagInput({ value, onChange, placeholder, id, suggestions }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; id?: string; suggestions?: string[] }) {
  const [text, setText] = useState('');
  const listId = useId();
  const add = (raw: string) => {
    const items = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const next = [...value];
    for (const i of items) if (!next.some((v) => v.toLowerCase() === i.toLowerCase())) next.push(i);
    onChange(next);
    setText('');
  };
  return (
    <div className="tag-input">
      {value.map((v) => (
        <span key={v} className="chip">
          {v}
          <button type="button" aria-label={`Remover ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>
            <X size={12} aria-hidden />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={text}
        list={suggestions ? listId : undefined}
        placeholder={value.length ? '' : placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ',') && text.trim()) {
            e.preventDefault();
            add(text);
          } else if (e.key === 'Backspace' && !text && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => text.trim() && add(text)}
      />
      {suggestions && (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
}

/** Seleção de arquivos por clique ou arrastar e soltar, com pré-visualização. */
export function FileDropzone({
  files,
  onChange,
  accept,
  multiple = true,
  label,
  hint,
  invalid,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  accept: string;
  multiple?: boolean;
  label: string;
  hint?: string;
  invalid?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const add = (list: FileList | null) => {
    if (!list) return;
    onChange(multiple ? [...files, ...Array.from(list)] : Array.from(list).slice(0, 1));
  };
  return (
    <div>
      <div
        className={`dropzone ${dragging ? 'dragging' : ''}`}
        role="button"
        tabIndex={0}
        aria-invalid={invalid || undefined}
        style={invalid ? { borderColor: 'var(--danger)' } : undefined}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), inputRef.current?.click())}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          add(e.dataTransfer.files);
        }}
      >
        <Upload size={24} aria-hidden style={{ color: 'var(--primary)' }} />
        <div style={{ fontWeight: 600 }}>{label}</div>
        {hint && <div className="small muted">{hint}</div>}
        <input ref={inputRef} type="file" hidden accept={accept} multiple={multiple} onChange={(e) => (add(e.target.files), (e.target.value = ''))} />
      </div>
      {files.length > 0 && (
        <ul className="file-list">
          {files.map((f, i) => (
            <FilePreview key={`${f.name}-${i}`} file={f} onRemove={() => onChange(files.filter((_, j) => j !== i))} />
          ))}
        </ul>
      )}
    </div>
  );
}

function FilePreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return (
    <li className="file-item">
      {url && file.type.startsWith('image/') && <img src={url} alt="" />}
      {url && file.type.startsWith('video/') && <video src={url} muted />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</div>
        <div className="tiny muted">{formatBytes(file.size)}</div>
      </div>
      <button type="button" className="btn btn-sm btn-ghost" onClick={onRemove} aria-label={`Remover ${file.name}`}>
        <X size={16} aria-hidden />
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
const STATUS_KIND: Record<string, string> = {
  draft: '',
  published: 'badge-success',
  unpublished: 'badge-warning',
  archived: 'badge-danger',
  open: 'badge-info',
  triage: '',
  in_progress: 'badge-warning',
  waiting_user: 'badge-orange',
  waiting_technical: 'badge-orange',
  resolved: 'badge-success',
  closed: '',
  pending: '',
  processing: 'badge-info',
  processed: 'badge-success',
  processed_with_warnings: 'badge-warning',
  failed: 'badge-danger',
  pending_review: 'badge-warning',
  approved: 'badge-success',
  rejected: 'badge-danger',
  low: '',
  medium: 'badge-warning',
  high: 'badge-danger',
  critical: 'badge-danger',
};

const ALL_LABELS: Record<string, string> = {
  ...ARTICLE_STATUS_LABELS,
  ...TICKET_STATUS_LABELS,
  ...DOCUMENT_STATUS_LABELS,
  ...DOCUMENT_REVIEW_LABELS,
  ...TICKET_PRIORITY_LABELS,
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${STATUS_KIND[status] ?? ''}`}>{ALL_LABELS[status] ?? status}</span>;
}

export function VisibilityBadge({ visibility }: { visibility: 'internal' | 'external' | string }) {
  return (
    <span className={`badge ${visibility === 'internal' ? 'badge-purple' : 'badge-info'}`} title={visibility === 'internal' ? 'Somente usuários internos autorizados' : 'Visível para clientes quando publicado'}>
      {VISIBILITY_LABELS[visibility as 'internal'] ?? visibility}
    </span>
  );
}

/** Destaca os termos (já marcados pelo servidor com \u0002 … \u0003) com escape seguro via React. */
export function Highlighted({ text }: { text: string }) {
  const parts = text.split(/(\u0002[^\u0003]*\u0003)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('\u0002') ? (
          <mark key={i} className="hl">
            {p.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/** Destaca termos (sem acento, sem diferenciar maiúsculas) em um texto simples. */
export function HighlightTerms({ text, terms }: { text: string; terms: string[] }) {
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const usable = terms.filter((t) => t.length >= 3);
  if (!usable.length) return <>{text}</>;
  // Normalização caractere a caractere para manter os índices alinhados ao texto original.
  const n = text
    .split('')
    .map((c) => norm(c)[0] ?? c)
    .join('');
  const marks: Array<[number, number]> = [];
  for (const t of usable) {
    const stem = t.length > 5 ? t.slice(0, t.length - 2) : t;
    let idx = n.indexOf(stem);
    while (idx >= 0) {
      let end = idx + stem.length;
      while (end < n.length && /[a-z0-9]/.test(n[end]!)) end++;
      marks.push([idx, end]);
      idx = n.indexOf(stem, end);
    }
  }
  if (!marks.length) return <>{text}</>;
  marks.sort((a, b) => a[0] - b[0]);
  const out: ReactNode[] = [];
  let pos = 0;
  marks.forEach(([s, e], i) => {
    if (s < pos) return;
    out.push(text.slice(pos, s), <mark key={i} className="hl">{text.slice(s, e)}</mark>);
    pos = e;
  });
  out.push(text.slice(pos));
  return <>{out}</>;
}

export function FileSize({ bytes }: { bytes: number }) {
  return <>{formatBytes(bytes)}</>;
}
