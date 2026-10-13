import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, errorMessage, fieldErrors, get, del, qs, upload } from '../../lib/api';
import { formatDate } from '../../lib/format';
import type { Taxonomy } from '../../lib/types';
import { PageHeader } from '../../components/Layout';
import { Button, ConfirmDialog, Empty, Field, Spinner } from '../../components/ui';
import { DocumentsPage } from './DocumentsPages';

const TYPES = [
  { value: 'requisicao', label: 'Requisição', seal: 'REQ', cls: 'seal-req' },
  { value: 'api', label: 'Documentação de API', seal: 'API', cls: 'seal-api' },
  { value: 'pdf', label: 'PDF/Manual', seal: 'PDF', cls: 'seal-pdf' },
  { value: 'planilha', label: 'Planilha', seal: 'XLS', cls: 'seal-xls' },
  { value: 'outro', label: 'Outro', seal: 'DOC', cls: 'seal-doc' },
] as const;
const ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.json,.yaml,.yml,.txt,.csv';

interface SupportDoc {
  id: string;
  title: string;
  type: (typeof TYPES)[number]['value'];
  system: { id: string; name: string };
  visibility: 'internal' | 'external';
  description: string | null;
  author: string;
  createdAt: string;
  externalUrl: string | null;
  file: { id: string; name: string; size: number; url: string } | null;
}

const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;

function SupportDocsTab() {
  const queryClient = useQueryClient();
  const taxonomy = useQuery({ queryKey: ['taxonomy'], queryFn: () => get<Taxonomy>('/api/taxonomy') });
  const [f, setF] = useState({ q: '', type: '', system: '' });
  const list = useQuery({ queryKey: ['support-docs', f], queryFn: () => get<{ items: SupportDoc[] }>(`/api/support-documents${qs(f)}`), placeholderData: (p) => p });
  const empty = { title: '', type: 'requisicao', systemId: '', visibility: 'internal', description: '', externalUrl: '' };
  const [form, setForm] = useState(empty);
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<SupportDoc | null>(null);
  const systems = taxonomy.data?.systems ?? [];

  const save = useMutation({
    mutationFn: async () => {
      const fd = new FormData();
      for (const [k, v] of Object.entries({ ...form, systemId: form.systemId || systems[0]?.id || '' })) fd.append(k, v);
      if (file) fd.append('file', file);
      return upload('/api/support-documents', fd);
    },
    onSuccess: () => {
      setForm(empty);
      setFile(null);
      setErrors({});
      if (fileInput.current) fileInput.current.value = '';
      setBanner({ kind: 'ok', text: 'Documento incluído.' });
      void queryClient.invalidateQueries({ queryKey: ['support-docs'] });
    },
    onError: (e) => {
      setErrors(fieldErrors(e));
      setBanner({ kind: 'err', text: e instanceof ApiError ? e.message : errorMessage(e) });
    },
  });

  const submit = () => {
    const missing: string[] = [];
    const e: Record<string, string> = {};
    if (!form.title.trim()) (missing.push('Título'), (e.title = 'Informe o título.'));
    if (missing.length) {
      setErrors(e);
      setBanner({ kind: 'err', text: `Preencha: ${missing.join(', ')}.` });
      return;
    }
    if (!file && !form.externalUrl.trim()) {
      setErrors({});
      setBanner({ kind: 'err', text: 'Anexe um arquivo ou informe um link externo.' });
      return;
    }
    setBanner(null);
    save.mutate();
  };

  return (
    <div className="stack" style={{ gap: 20 }}>
      <section className="card card-body" aria-labelledby="incl-title">
        <h2 id="incl-title">Incluir documento</h2>
        {banner && (
          <p role={banner.kind === 'ok' ? 'status' : 'alert'} className={`banner ${banner.kind === 'ok' ? 'banner-success' : 'banner-error'}`} style={{ marginBottom: 12 }}>
            {banner.text}
          </p>
        )}
        <div className="grid grid-2">
          <Field label="Título" htmlFor="sd-title" required error={errors.title}>
            <input id="sd-title" className="input" placeholder="Ex.: API de pedidos — v2" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field label="Tipo" htmlFor="sd-type" required>
            <select id="sd-type" className="select" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
          <Field label="Sistema" htmlFor="sd-sys" required error={errors.systemId}>
            <select id="sd-sys" className="select" value={form.systemId || systems[0]?.id || ''} onChange={(e) => setForm({ ...form, systemId: e.target.value })}>
              {systems.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Visibilidade" htmlFor="sd-vis" required>
            <select id="sd-vis" className="select" value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })}>
              <option value="internal">Interno</option>
              <option value="external">Externo</option>
            </select>
          </Field>
        </div>
        <div style={{ marginTop: 14 }}>
          <Field label="Descrição" htmlFor="sd-desc">
            <textarea id="sd-desc" className="textarea" rows={3} placeholder="Para que serve e quando usar." value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
        </div>
        <div className="grid grid-2" style={{ marginTop: 14 }}>
          <Field label="Arquivo" htmlFor="sd-file" hint="PDF, Word, Excel, JSON, YAML ou texto." error={errors.file}>
            <input id="sd-file" ref={fileInput} type="file" accept={ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            {file && <span className="small muted">{file.name} · {kb(file.size)}</span>}
          </Field>
          <Field label="ou link externo" htmlFor="sd-url" error={errors.externalUrl}>
            <input id="sd-url" className="input" placeholder="https://" value={form.externalUrl} onChange={(e) => setForm({ ...form, externalUrl: e.target.value })} />
          </Field>
        </div>
        <div style={{ marginTop: 16 }}>
          <Button variant="cta" onClick={submit} loading={save.isPending}>
            {save.isPending ? 'Incluindo…' : 'Incluir documento'}
          </Button>
        </div>
      </section>

      <div className="card card-body">
        <div className="grid grid-3">
          <Field label="Pesquisar" htmlFor="sf-q"><input id="sf-q" className="input" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></Field>
          <Field label="Tipo" htmlFor="sf-t">
            <select id="sf-t" className="select" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
              <option value="">Todos</option>
              {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
          <Field label="Sistema" htmlFor="sf-s">
            <select id="sf-s" className="select" value={f.system} onChange={(e) => setF({ ...f, system: e.target.value })}>
              <option value="">Todos</option>
              {systems.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
        </div>
      </div>

      {list.isLoading ? (
        <Spinner />
      ) : !list.data?.items.length ? (
        <div className="card"><Empty title="Nenhum documento corresponde aos filtros aplicados." /></div>
      ) : (
        <ul className="card doc-list" aria-live="polite" data-testid="support-doc-list">
          {list.data.items.map((d) => {
            const t = TYPES.find((x) => x.value === d.type) ?? TYPES[4];
            const href = d.file ? d.file.url : d.externalUrl;
            return (
              <li key={d.id}>
                <span className={`doc-seal ${t.cls}`} aria-hidden>{t.seal}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <strong>{d.title}</strong>
                    <span className={`badge ${d.visibility === 'external' ? 'badge-success' : 'badge-info'}`}>{d.visibility === 'external' ? 'Externo' : 'Interno'}</span>
                    <span className="badge">{d.system.name}</span>
                  </div>
                  {d.description && <p className="small" style={{ margin: '4px 0' }}>{d.description}</p>}
                  <div className="tiny muted">{t.label} · {d.author} · {formatDate(d.createdAt)} · {d.file ? `${d.file.name} (${kb(d.file.size)})` : 'link externo'}</div>
                </div>
                <div className="btn-group">
                  {href && <a className="btn btn-sm" href={href} target="_blank" rel="noreferrer noopener">Abrir</a>}
                  <Button size="sm" variant="danger" onClick={() => setRemoving(d)}>Excluir</Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {removing && (
        <ConfirmDialog
          title="Excluir documento?"
          danger
          confirmLabel="Excluir"
          message={`“${removing.title}” deixará de aparecer na lista. A exclusão fica registrada na auditoria.`}
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            await del(`/api/support-documents/${removing.id}`);
            setRemoving(null);
            setBanner({ kind: 'ok', text: 'Documento excluído.' });
            await queryClient.invalidateQueries({ queryKey: ['support-docs'] });
          }}
        />
      )}
    </div>
  );
}

/** Documentos: material de apoio (design Logaz) + importação para pesquisa e IA. */
export function DocumentsHubPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('aba') === 'importados' ? 'importados' : 'apoio';
  return (
    <div className="page">
      <PageHeader title="Documentos" subtitle="Material de apoio do suporte: requisições, documentação de APIs, manuais em PDF e planilhas." />
      <div className="tabs" role="tablist" aria-label="Tipos de documento" style={{ marginBottom: 16 }}>
        <button type="button" role="tab" aria-selected={tab === 'apoio'} className={tab === 'apoio' ? 'tab active' : 'tab'} onClick={() => setParams({}, { replace: true })}>Material de apoio</button>
        <button type="button" role="tab" aria-selected={tab === 'importados'} className={tab === 'importados' ? 'tab active' : 'tab'} onClick={() => setParams({ aba: 'importados' }, { replace: true })}>Importados para pesquisa e IA</button>
      </div>
      {tab === 'apoio' ? <SupportDocsTab /> : <DocumentsPage />}
    </div>
  );
}
