import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { KeyRound } from 'lucide-react';
import { errorMessage, fieldErrors, post } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { PageHeader } from '../components/Layout';
import { Alert, Button, Field } from '../components/ui';

export function AccountPage() {
  const { user } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ kind: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!user) return <Navigate to="/entrar?voltar=/conta" replace />;
  return (
    <div className="page" style={{ maxWidth: 560 }}>
      <PageHeader title="Minha conta" subtitle={`${user.name} · ${user.email}${user.company ? ` · ${user.company.name}` : ''}`} />
      <form
        className="card card-body stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setMessage(null);
          if (next !== confirm) return setErrors({ confirm: 'As senhas não conferem.' });
          setBusy(true);
          try {
            await post('/api/auth/change-password', { currentPassword: current, newPassword: next });
            setErrors({});
            setCurrent('');
            setNext('');
            setConfirm('');
            setMessage({ kind: 'success', text: 'Senha alterada. As demais sessões foram encerradas.' });
          } catch (err) {
            setErrors(fieldErrors(err));
            setMessage({ kind: 'danger', text: errorMessage(err) });
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2 style={{ fontSize: '1.05rem', margin: 0 }}>
          <KeyRound size={18} aria-hidden style={{ verticalAlign: 'middle' }} /> Alterar senha
        </h2>
        <Field label="Senha atual" htmlFor="pw-current" required error={errors.currentPassword}>
          <input id="pw-current" type="password" autoComplete="current-password" className="input" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="Nova senha" htmlFor="pw-new" required hint="Mínimo de 10 caracteres, com letras e números." error={errors.newPassword}>
          <input id="pw-new" type="password" autoComplete="new-password" className="input" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="Confirmar nova senha" htmlFor="pw-confirm" required error={errors.confirm}>
          <input id="pw-confirm" type="password" autoComplete="new-password" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        {message && <Alert kind={message.kind}>{message.text}</Alert>}
        <Button type="submit" variant="primary" loading={busy} disabled={!current || !next}>
          Alterar senha
        </Button>
      </form>
    </div>
  );
}
