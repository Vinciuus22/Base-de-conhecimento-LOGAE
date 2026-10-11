import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Sparkles, Ticket, User } from 'lucide-react';
import { TICKET_PRIORITY_LABELS, TICKET_REQUEST_TYPE_LABELS, TICKET_REQUEST_TYPES } from '@shared/domain';
import { IMAGE_MIME_TYPES, VIDEO_MIME_TYPES, formatBytes } from '@shared/uploads';
import { ApiError, errorMessage, fieldErrors, get, post, upload } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { PageHeader } from '../../components/Layout';
import { Alert, Button, Field, FileDropzone, Modal, Spinner } from '../../components/ui';

interface FormOptions {
  user: { id: string; name: string; email: string };
  company: { id: string; name: string } | null;
  companies: Array<{ id: string; name: string }>;
  systems: Array<{ id: string; name: string }>;
  categories: Array<{ id: string; name: string }>;
  limits: { maxImageMb: number; maxVideoMb: number; maxFiles: number };
}

const MEDIA = [...IMAGE_MIME_TYPES, ...VIDEO_MIME_TYPES] as readonly string[];

export function NewTicketPage() {
  const { user, config } = useAuth();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { draft?: { title?: string; description?: string }; fromChat?: boolean } };
  const draft = location.state?.draft;
  const options = useQuery({ queryKey: ['ticket-form'], queryFn: () => get<FormOptions>('/api/tickets/form-options'), enabled: !!user });

  const [title, setTitle] = useState(draft?.title ?? '');
  const [description, setDescription] = useState(draft?.description ?? '');
  const [systemId, setSystemId] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [requestType, setRequestType] = useState('incident');
  const [categoryId, setCategoryId] = useState('');
  const [priority, setPriority] = useState('medium');
  const [files, setFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reviewing, setReviewing] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; protocol: string } | null>(null);
  const [assist, setAssist] = useState<{ suggestedDescription: string; missingInformation: string[] } | null>(null);
  const [assistBusy, setAssistBusy] = useState(false);
  const [assistError, setAssistError] = useState<string | null>(null);

  if (!user) {
    return (
      <div className="page page-narrow">
        <Alert kind="info" title="Entre para abrir um ticket">
          Para abrir e acompanhar tickets é necessário estar autenticado.{' '}
          <Link to={`/entrar?voltar=/tickets/novo`}>Entrar</Link>
        </Alert>
      </div>
    );
  }
  if (options.isLoading || !options.data) return <Spinner />;
  const opts = options.data;

  // Validação no frontend (o backend valida novamente todos os campos e arquivos).
  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (!systemId) e.systemId = 'Selecione o sistema.';
    if (!opts.company && !companyId) e.companyId = 'Selecione a empresa.';
    if (description.trim().length < 10) e.description = 'Descreva o problema com pelo menos 10 caracteres.';
    const media = files.filter((f) => MEDIA.includes(f.type));
    if (!media.length) e.files = 'Anexe pelo menos uma imagem ou vídeo.';
    const invalid = files.find((f) => !MEDIA.includes(f.type));
    if (invalid) e.files = `Arquivo não permitido: ${invalid.name}. Envie imagens (PNG, JPG, WEBP, GIF) ou vídeos (MP4, WEBM, MOV).`;
    const big = files.find((f) => f.size > (f.type.startsWith('video/') ? opts.limits.maxVideoMb : opts.limits.maxImageMb) * 1024 * 1024);
    if (big) e.files = `O arquivo ${big.name} (${formatBytes(big.size)}) excede o limite permitido.`;
    if (files.length > opts.limits.maxFiles) e.files = `Envie no máximo ${opts.limits.maxFiles} arquivos.`;
    return e;
  };

  const review = () => {
    const e = validate();
    setErrors(e);
    if (!Object.keys(e).length) setReviewing(true);
  };

  const submit = async () => {
    setSubmitError(null);
    const form = new FormData();
    form.append('title', title);
    form.append('description', description);
    form.append('systemId', systemId);
    if (companyId) form.append('companyId', companyId);
    form.append('requestType', requestType);
    if (categoryId) form.append('categoryId', categoryId);
    form.append('priority', priority);
    for (const f of files) form.append('files', f, f.name);
    try {
      setProgress(0);
      const res = await upload<{ ticket: { id: string; protocol: string } }>('/api/tickets', form, setProgress);
      setCreated(res.ticket);
      setReviewing(false);
    } catch (err) {
      setErrors(fieldErrors(err));
      setSubmitError(errorMessage(err));
    } finally {
      setProgress(null);
    }
  };

  const requestAssist = async () => {
    setAssistError(null);
    setAssistBusy(true);
    try {
      const res = await post<{ suggestedDescription: string; missingInformation: string[] }>('/api/ai/ticket-assist', {
        description,
        title,
        system: opts.systems.find((s) => s.id === systemId)?.name ?? '',
      });
      setAssist(res);
    } catch (err) {
      setAssistError(err instanceof ApiError && err.status === 503 ? 'O auxílio da IA não está disponível no momento.' : errorMessage(err));
    } finally {
      setAssistBusy(false);
    }
  };

  if (created) {
    return (
      <div className="page page-narrow">
        <div className="card card-body" style={{ textAlign: 'center' }}>
          <CheckCircle2 size={48} aria-hidden style={{ color: 'var(--success)' }} />
          <h1 style={{ fontSize: '1.5rem' }}>Ticket aberto com sucesso</h1>
          <p>
            Protocolo: <strong style={{ fontSize: '1.2rem' }} data-testid="protocol">{created.protocol}</strong>
          </p>
          <p className="muted">Você pode acompanhar o atendimento a qualquer momento em “Meus tickets”.</p>
          <div className="btn-group" style={{ justifyContent: 'center' }}>
            <Link className="btn btn-primary" to={`/tickets/${created.id}`}>
              Acompanhar ticket
            </Link>
            <Link className="btn" to="/tickets">
              Meus tickets
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const systemName = opts.systems.find((s) => s.id === systemId)?.name;
  const companyName = opts.company?.name ?? opts.companies.find((c) => c.id === companyId)?.name;

  return (
    <div className="page page-narrow">
      <PageHeader title="Abrir ticket" subtitle="Descreva o problema para que a equipe de suporte técnico possa analisar." icon={<Ticket size={24} aria-hidden />} />
      {location.state?.fromChat && (
        <Alert kind="info">Os campos foram pré-preenchidos com a sua conversa com o assistente. Revise e complete as informações antes de enviar.</Alert>
      )}
      <form
        className="card card-body stack"
        style={{ marginTop: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          review();
        }}
        noValidate
      >
        <div className="grid grid-2">
          <Field label="Usuário" required hint="Preenchido automaticamente.">
            <div className="input row" style={{ gap: 8, background: 'var(--surface-2)' }}>
              <User size={16} aria-hidden /> {opts.user.name} ({opts.user.email})
            </div>
          </Field>
          {opts.company ? (
            <Field label="Empresa" required hint="Vinculada ao seu cadastro.">
              <div className="input" style={{ background: 'var(--surface-2)' }}>
                {opts.company.name}
              </div>
            </Field>
          ) : (
            <Field label="Empresa" htmlFor="t-company" required error={errors.companyId}>
              <select id="t-company" className="select" value={companyId} onChange={(e) => setCompanyId(e.target.value)} aria-invalid={!!errors.companyId}>
                <option value="">Selecione…</option>
                {opts.companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Sistema" htmlFor="t-system" required error={errors.systemId}>
            <select id="t-system" className="select" value={systemId} onChange={(e) => setSystemId(e.target.value)} aria-invalid={!!errors.systemId}>
              <option value="">Selecione o sistema ou módulo…</option>
              {opts.systems.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Tipo de solicitação" htmlFor="t-type">
            <select id="t-type" className="select" value={requestType} onChange={(e) => setRequestType(e.target.value)}>
              {TICKET_REQUEST_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TICKET_REQUEST_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Categoria" htmlFor="t-cat">
            <select id="t-cat" className="select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Não sei / outra</option>
              {opts.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Prioridade" htmlFor="t-prio">
            <select id="t-prio" className="select" value={priority} onChange={(e) => setPriority(e.target.value)}>
              {(['low', 'medium', 'high'] as const).map((p) => (
                <option key={p} value={p}>
                  {TICKET_PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Título" htmlFor="t-title" hint="Opcional. Se vazio, será gerado a partir da descrição.">
          <input id="t-title" className="input" value={title} maxLength={150} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field
          label="Descrição"
          htmlFor="t-desc"
          required
          error={errors.description}
          hint="Informe o que estava tentando fazer, o que aconteceu, o que deveria acontecer, os passos para reproduzir e a mensagem de erro."
        >
          <textarea id="t-desc" className="textarea" style={{ minHeight: 170 }} value={description} onChange={(e) => setDescription(e.target.value)} aria-invalid={!!errors.description} maxLength={20000} />
        </Field>
        {config?.ai.generative && (
          <div>
            <Button size="sm" onClick={requestAssist} loading={assistBusy} disabled={description.trim().length < 5}>
              <Sparkles size={14} aria-hidden /> Melhorar descrição com a IA
            </Button>
            <span className="tiny muted" style={{ marginLeft: 8 }}>A IA apenas organiza o que você escreveu; nada é enviado sem a sua confirmação.</span>
            {assistError && <div className="small" style={{ color: 'var(--danger)', marginTop: 6 }}>{assistError}</div>}
          </div>
        )}
        <Field label="Imagens ou vídeos" required error={errors.files}>
          <FileDropzone
            files={files}
            onChange={setFiles}
            accept={MEDIA.join(',')}
            label="Clique ou arraste capturas de tela e vídeos"
            hint={`Obrigatório pelo menos um arquivo. Imagens até ${opts.limits.maxImageMb} MB, vídeos até ${opts.limits.maxVideoMb} MB.`}
            invalid={!!errors.files}
          />
        </Field>
        {submitError && !reviewing && <Alert kind="danger">{submitError}</Alert>}
        <div className="btn-group" style={{ justifyContent: 'flex-end' }}>
          <Button onClick={() => navigate(-1)}>Cancelar</Button>
          <Button type="submit" variant="primary">
            Revisar e enviar
          </Button>
        </div>
      </form>

      {assist && (
        <Modal
          title="Sugestão de descrição"
          onClose={() => setAssist(null)}
          wide
          footer={
            <>
              <Button onClick={() => setAssist(null)}>Manter minha descrição</Button>
              <Button
                variant="primary"
                onClick={() => {
                  setDescription(assist.suggestedDescription);
                  setAssist(null);
                }}
              >
                Usar sugestão (editável)
              </Button>
            </>
          }
        >
          <Alert kind="info">Revise o texto: a IA utilizou apenas as informações fornecidas por você.</Alert>
          <pre className="diff" style={{ marginTop: 12, fontFamily: 'inherit' }}>{assist.suggestedDescription}</pre>
          {assist.missingInformation.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <strong>Informações que ajudariam a análise:</strong>
              <ul>
                {assist.missingInformation.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </div>
          )}
        </Modal>
      )}

      {reviewing && (
        <Modal
          title="Revise as informações antes de enviar"
          onClose={() => setReviewing(false)}
          footer={
            <>
              <Button onClick={() => setReviewing(false)} disabled={progress !== null}>
                Voltar e editar
              </Button>
              <Button variant="primary" onClick={submit} loading={progress !== null}>
                Confirmar e abrir ticket
              </Button>
            </>
          }
        >
          <dl className="detail-list">
            <dt>Usuário</dt>
            <dd>{opts.user.name}</dd>
            <dt>Empresa</dt>
            <dd>{companyName}</dd>
            <dt>Sistema</dt>
            <dd>{systemName}</dd>
            <dt>Tipo</dt>
            <dd>{TICKET_REQUEST_TYPE_LABELS[requestType as 'incident']}</dd>
            <dt>Prioridade</dt>
            <dd>{TICKET_PRIORITY_LABELS[priority as 'low']}</dd>
            <dt>Título</dt>
            <dd>{title || '(gerado da descrição)'}</dd>
            <dt>Anexos</dt>
            <dd>{files.map((f) => f.name).join(', ')}</dd>
          </dl>
          <p className="label" style={{ marginTop: 12 }}>
            Descrição
          </p>
          <div className="diff" style={{ fontFamily: 'inherit' }}>{description}</div>
          {progress !== null && (
            <p className="small muted" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
              Enviando… {progress}%
            </p>
          )}
          {submitError && <Alert kind="danger">{submitError}</Alert>}
        </Modal>
      )}
    </div>
  );
}
