import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, KeyRound, Plus, UserX, Users } from 'lucide-react';
import type { PermissionDefinition, RoleDefinition } from '@shared/permissions';
import { errorMessage, fieldErrors, get, post, put, qs } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useAuth } from '../../context/AuthContext';
import { PageHeader } from '../../components/Layout';
import { Alert, Button, ConfirmDialog, Empty, Field, Modal, Pagination, Spinner, useToast } from '../../components/ui';

interface UserRow {
  id: string;
  name: string;
  email: string;
  userType: 'internal' | 'external';
  active: boolean;
  lastLoginAt: string | null;
  company: string | null;
  roles: string[];
}
interface UserDetail {
  id: string;
  name: string;
  email: string;
  userType: 'internal' | 'external';
  company: { id: string; name: string } | null;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  anonymizedAt: string | null;
  roles: string[];
  effectivePermissions: string[];
  overrides: Array<{ permission: string; effect: 'grant' | 'deny'; grantedAt: string; grantedBy: string | null }>;
}
type Company = { id: string; name: string; document: string | null; active: boolean; userCount: number };

function useCatalog() {
  return useQuery({ queryKey: ['permission-catalog'], queryFn: () => get<{ permissions: PermissionDefinition[]; roles: RoleDefinition[] }>('/api/admin/permissions'), staleTime: Infinity });
}
function useCompanies() {
  return useQuery({ queryKey: ['companies'], queryFn: () => get<{ items: Company[] }>('/api/companies') });
}

export function UsersPage() {
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: ['users', q, type, page], queryFn: () => get<{ total: number; items: UserRow[] }>(`/api/users${qs({ q, userType: type, page, pageSize: 25 })}`) });
  return (
    <div className="page">
      <PageHeader
        title="Usuários e permissões"
        subtitle="Perfis definem o conjunto inicial; permissões podem ser concedidas ou revogadas individualmente."
        icon={<Users size={24} aria-hidden />}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={16} aria-hidden /> Novo usuário
          </Button>
        }
      />
      <div className="card card-body row" style={{ marginBottom: 16 }}>
        <input className="input" style={{ maxWidth: 320 }} placeholder="Nome ou e-mail" aria-label="Pesquisar usuários" value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} />
        <select className="select" style={{ width: 'auto' }} aria-label="Tipo de usuário" value={type} onChange={(e) => (setType(e.target.value), setPage(1))}>
          <option value="">Todos</option>
          <option value="internal">Internos</option>
          <option value="external">Externos</option>
        </select>
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : !list.data?.items.length ? (
        <div className="card">
          <Empty title="Nenhum usuário encontrado." />
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>E-mail</th>
                <th>Tipo</th>
                <th>Empresa</th>
                <th>Perfis</th>
                <th>Situação</th>
                <th>Último acesso</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((u) => (
                <tr key={u.id}>
                  <td>
                    <Link to={`/interno/usuarios/${u.id}`}>{u.name}</Link>
                  </td>
                  <td>{u.email}</td>
                  <td>{u.userType === 'internal' ? 'Interno' : 'Externo'}</td>
                  <td>{u.company ?? '—'}</td>
                  <td className="small">{u.roles.join(', ') || '—'}</td>
                  <td>{u.active ? <span className="badge badge-success">Ativo</span> : <span className="badge badge-danger">Inativo</span>}</td>
                  <td className="small">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'Nunca'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data && <Pagination page={page} pageSize={25} total={list.data.total} onChange={setPage} />}
      {creating && <CreateUserModal onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateUserModal({ onClose }: { onClose: () => void }) {
  const catalog = useCatalog();
  const companies = useCompanies();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ name: '', email: '', userType: 'internal' as 'internal' | 'external', companyId: '', roles: [] as string[], password: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [temp, setTemp] = useState<string | null>(null);
  const roles = catalog.data?.roles.filter((r) => r.userType === form.userType) ?? [];

  if (temp) {
    return (
      <Modal title="Usuário criado" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Concluir</Button>}>
        <Alert kind="warning" title="Senha temporária (exibida somente agora)">
          <code style={{ fontSize: '1.05rem' }}>{temp}</code>
          <p className="small" style={{ margin: '6px 0 0' }}>Entregue a senha ao usuário por um canal seguro e oriente a troca no primeiro acesso.</p>
        </Alert>
      </Modal>
    );
  }
  return (
    <Modal
      title="Novo usuário"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const res = await post<{ temporaryPassword?: string }>('/api/users', { ...form, companyId: form.companyId || null, password: form.password || undefined });
                await queryClient.invalidateQueries({ queryKey: ['users'] });
                if (res.temporaryPassword) setTemp(res.temporaryPassword);
                else onClose();
              } catch (err) {
                setErrors(fieldErrors(err));
                setError(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            Criar usuário
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Nome" htmlFor="nu-name" required error={errors.name}>
          <input id="nu-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="E-mail" htmlFor="nu-email" required error={errors.email}>
          <input id="nu-email" type="email" className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Tipo" required>
          <div className="segmented" role="group" aria-label="Tipo de usuário">
            <button type="button" aria-pressed={form.userType === 'internal'} onClick={() => setForm({ ...form, userType: 'internal', roles: [] })}>
              Interno
            </button>
            <button type="button" aria-pressed={form.userType === 'external'} onClick={() => setForm({ ...form, userType: 'external', roles: ['external'] })}>
              Externo (cliente)
            </button>
          </div>
        </Field>
        <Field label="Empresa" htmlFor="nu-company" required={form.userType === 'external'} error={errors.companyId}>
          <select id="nu-company" className="select" value={form.companyId} onChange={(e) => setForm({ ...form, companyId: e.target.value })}>
            <option value="">{form.userType === 'internal' ? 'Nenhuma' : 'Selecione…'}</option>
            {companies.data?.items.filter((c) => c.active).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 6 }}>
          <legend className="label">Perfis</legend>
          {roles.map((r) => (
            <label key={r.key} className="checkbox">
              <input
                type="checkbox"
                checked={form.roles.includes(r.key)}
                onChange={(e) => setForm({ ...form, roles: e.target.checked ? [...form.roles, r.key] : form.roles.filter((x) => x !== r.key) })}
              />
              <span>
                <strong>{r.name}</strong> <span className="small muted">— {r.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Field label="Senha inicial" htmlFor="nu-pass" hint="Opcional. Se vazia, uma senha temporária será gerada." error={errors.password}>
          <input id="nu-pass" type="password" autoComplete="new-password" className="input" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        {error && <Alert kind="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}

export function UserDetailPage() {
  const { id = '' } = useParams();
  const { user: me } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const catalog = useCatalog();
  const companies = useCompanies();
  const detail = useQuery({ queryKey: ['user', id], queryFn: () => get<{ user: UserDetail }>(`/api/users/${id}`).then((r) => r.user) });
  const [confirm, setConfirm] = useState<null | 'reset' | 'anonymize' | 'toggle'>(null);
  const [temp, setTemp] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [anonConfirm, setAnonConfirm] = useState('');

  if (detail.isLoading || !catalog.data) return <Spinner />;
  if (!detail.data) return <div className="page"><Alert kind="danger">{errorMessage(detail.error)}</Alert></div>;
  const u = detail.data;
  const refresh = (next: UserDetail) => queryClient.setQueryData(['user', id], next);

  const setPermission = async (permission: string, effect: 'grant' | 'deny' | 'inherit') => {
    setError(null);
    try {
      const res = await put<{ user: UserDetail }>(`/api/users/${id}/permissions/${permission}`, { effect });
      refresh(res.user);
      toast('success', effect === 'grant' ? 'Permissão concedida.' : effect === 'deny' ? 'Permissão revogada.' : 'Exceção removida (volta ao perfil).');
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const toggleRole = async (key: string, on: boolean) => {
    setError(null);
    try {
      const roles = on ? [...u.roles, key] : u.roles.filter((r) => r !== key);
      const res = await put<{ user: UserDetail }>(`/api/users/${id}/roles`, { roles });
      refresh(res.user);
      toast('success', 'Perfis atualizados.');
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const groups = [...new Set(catalog.data.permissions.map((p) => p.group))];

  return (
    <div className="page">
      <PageHeader
        title={u.name}
        subtitle={`${u.email} · ${u.userType === 'internal' ? 'Usuário interno' : 'Usuário externo'}${u.company ? ` · ${u.company.name}` : ''}`}
        actions={
          <>
            <Button onClick={() => setConfirm('reset')}>
              <KeyRound size={16} aria-hidden /> Redefinir senha
            </Button>
            {u.id !== me?.id && (
              <Button onClick={() => setConfirm('toggle')}>{u.active ? 'Desativar' : 'Reativar'}</Button>
            )}
            {u.id !== me?.id && !u.anonymizedAt && (
              <Button variant="danger" onClick={() => setConfirm('anonymize')}>
                <UserX size={16} aria-hidden /> Anonimizar (LGPD)
              </Button>
            )}
          </>
        }
      />
      {error && <Alert kind="danger">{error}</Alert>}
      {temp && (
        <Alert kind="warning" title="Senha temporária (exibida somente agora)">
          <code>{temp}</code>
        </Alert>
      )}
      <div className="grid grid-2" style={{ marginTop: 12, alignItems: 'start' }}>
        <section className="card card-body stack">
          <h2 style={{ fontSize: '1.05rem', margin: 0 }}>Dados</h2>
          <dl className="detail-list">
            <dt>Situação</dt>
            <dd>{u.anonymizedAt ? 'Anonimizado' : u.active ? 'Ativo' : 'Inativo'}</dd>
            <dt>Criado em</dt>
            <dd>{formatDateTime(u.createdAt)}</dd>
            <dt>Último acesso</dt>
            <dd>{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'Nunca'}</dd>
          </dl>
          <Field label="Empresa" htmlFor="ud-company">
            <select
              id="ud-company"
              className="select"
              value={u.company?.id ?? ''}
              onChange={async (e) => {
                try {
                  const res = await put<{ user: UserDetail }>(`/api/users/${id}`, { name: u.name, companyId: e.target.value || null, active: u.active });
                  refresh(res.user);
                  toast('success', 'Empresa atualizada.');
                } catch (err) {
                  setError(errorMessage(err));
                }
              }}
            >
              <option value="">Nenhuma</option>
              {companies.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <h2 style={{ fontSize: '1.05rem', margin: '8px 0 0' }}>Perfis</h2>
          {catalog.data.roles
            .filter((r) => r.userType === u.userType)
            .map((r) => (
              <label key={r.key} className="checkbox">
                <input type="checkbox" checked={u.roles.includes(r.key)} onChange={(e) => toggleRole(r.key, e.target.checked)} />
                <span>
                  <strong>{r.name}</strong> <span className="small muted">— {r.description}</span>
                </span>
              </label>
            ))}
        </section>
        <section className="card card-body">
          <h2 style={{ fontSize: '1.05rem' }}>Permissões individuais</h2>
          <p className="small muted">“Herdar” usa o que os perfis definem. Conceder ou revogar cria uma exceção registrada na auditoria.</p>
          {groups.map((g) => (
            <div key={g} style={{ marginBottom: 12 }}>
              <h3 className="small" style={{ textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-faint)' }}>
                {g}
              </h3>
              {catalog.data!.permissions
                .filter((p) => p.group === g)
                .map((p) => {
                  const override = u.overrides.find((o) => o.permission === p.key);
                  const effective = u.effectivePermissions.includes(p.key);
                  const disabled = p.internalOnly && u.userType === 'external';
                  return (
                    <div key={p.key} className="row" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                      <div style={{ flex: 1, minWidth: 200 }}>
                        <strong className="small">{p.label}</strong> {effective ? <span className="badge badge-success">Ativa</span> : <span className="badge">Inativa</span>}
                        <div className="tiny muted">{disabled ? 'Exclusiva de usuários internos.' : p.description}</div>
                        {override && (
                          <div className="tiny muted">
                            {override.effect === 'grant' ? 'Concedida' : 'Revogada'} por {override.grantedBy ?? '—'} em {formatDateTime(override.grantedAt)}
                          </div>
                        )}
                      </div>
                      <select
                        className="select"
                        style={{ width: 'auto', minHeight: 32 }}
                        aria-label={`Permissão ${p.label}`}
                        value={override?.effect ?? 'inherit'}
                        disabled={disabled}
                        onChange={(e) => setPermission(p.key, e.target.value as 'grant')}
                      >
                        <option value="inherit">Herdar do perfil</option>
                        <option value="grant">Conceder</option>
                        <option value="deny">Revogar</option>
                      </select>
                    </div>
                  );
                })}
            </div>
          ))}
        </section>
      </div>

      {confirm === 'reset' && (
        <ConfirmDialog
          title="Redefinir senha"
          message="Uma senha temporária será gerada e todas as sessões do usuário serão encerradas."
          confirmLabel="Redefinir"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const res = await post<{ temporaryPassword: string }>(`/api/users/${id}/reset-password`).catch((err) => {
              throw new Error(errorMessage(err));
            });
            setTemp(res.temporaryPassword);
            setConfirm(null);
          }}
        />
      )}
      {confirm === 'toggle' && (
        <ConfirmDialog
          title={u.active ? 'Desativar usuário' : 'Reativar usuário'}
          message={u.active ? 'O usuário perderá o acesso imediatamente e suas sessões e bloqueios de edição serão encerrados.' : 'O usuário voltará a ter acesso.'}
          danger={u.active}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const res = await put<{ user: UserDetail }>(`/api/users/${id}`, { name: u.name, companyId: u.company?.id ?? null, active: !u.active }).catch((err) => {
              throw new Error(errorMessage(err));
            });
            refresh(res.user);
            setConfirm(null);
          }}
        />
      )}
      {confirm === 'anonymize' && (
        <Modal
          title="Anonimizar dados pessoais"
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button onClick={() => setConfirm(null)}>Cancelar</Button>
              <Button
                variant="danger"
                disabled={anonConfirm !== 'ANONIMIZAR'}
                onClick={async () => {
                  try {
                    await post(`/api/users/${id}/anonymize`, { confirm: anonConfirm });
                    toast('success', 'Usuário anonimizado.');
                    setConfirm(null);
                    await detail.refetch();
                  } catch (err) {
                    setError(errorMessage(err));
                  }
                }}
              >
                Anonimizar
              </Button>
            </>
          }
        >
          <p>O nome e o e-mail serão substituídos, o acesso será bloqueado e as conversas com a IA serão excluídas. Os registros de tickets, artigos e auditoria são mantidos para rastreabilidade. Esta ação é irreversível.</p>
          <Field label='Digite "ANONIMIZAR" para confirmar' htmlFor="anon">
            <input id="anon" className="input" value={anonConfirm} onChange={(e) => setAnonConfirm(e.target.value)} />
          </Field>
        </Modal>
      )}
    </div>
  );
}

export function CompaniesPage() {
  const companies = useCompanies();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<Partial<Company> | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="page">
      <PageHeader
        title="Empresas"
        icon={<Building2 size={24} aria-hidden />}
        actions={
          <Button variant="primary" onClick={() => setEditing({ name: '', document: '', active: true })}>
            <Plus size={16} aria-hidden /> Nova empresa
          </Button>
        }
      />
      {companies.isLoading ? (
        <Spinner />
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Documento</th>
                <th>Usuários</th>
                <th>Situação</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {companies.data?.items.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{c.document ?? '—'}</td>
                  <td>{c.userCount}</td>
                  <td>{c.active ? 'Ativa' : 'Inativa'}</td>
                  <td>
                    <Button size="sm" onClick={() => setEditing(c)}>
                      Editar
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <Modal
          title={editing.id ? 'Editar empresa' : 'Nova empresa'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button onClick={() => setEditing(null)}>Cancelar</Button>
              <Button
                variant="primary"
                onClick={async () => {
                  setError(null);
                  try {
                    const body = { name: editing.name, document: editing.document || null, active: editing.active ?? true };
                    if (editing.id) await put(`/api/companies/${editing.id}`, body);
                    else await post('/api/companies', body);
                    await queryClient.invalidateQueries({ queryKey: ['companies'] });
                    toast('success', 'Empresa salva.');
                    setEditing(null);
                  } catch (err) {
                    setError(errorMessage(err));
                  }
                }}
              >
                Salvar
              </Button>
            </>
          }
        >
          <div className="stack">
            <Field label="Nome" htmlFor="co-name" required>
              <input id="co-name" className="input" value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <Field label="CNPJ / documento" htmlFor="co-doc">
              <input id="co-doc" className="input" value={editing.document ?? ''} onChange={(e) => setEditing({ ...editing, document: e.target.value })} />
            </Field>
            <label className="checkbox">
              <input type="checkbox" checked={editing.active ?? true} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> Ativa
            </label>
            {error && <Alert kind="danger">{error}</Alert>}
          </div>
        </Modal>
      )}
    </div>
  );
}
