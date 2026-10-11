import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { LogIn } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { errorMessage } from '../lib/api';
import { Alert, Button, Field } from '../components/ui';

export function LoginPage() {
  const { login, user } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const back = params.get('voltar');
  const target = back && back.startsWith('/') && !back.startsWith('//') ? back : '/';

  if (user) return <Navigate to={target} replace />;

  return (
    <div className="page" style={{ maxWidth: 440 }}>
      <div className="card card-body">
        <h1 style={{ fontSize: '1.4rem' }}>Entrar</h1>
        <p className="muted small">Acesse para acompanhar seus tickets e, se for colaborador, o ambiente interno.</p>
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await login(email, password);
              navigate(target, { replace: true });
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="E-mail" htmlFor="email" required>
            <input id="email" type="email" className="input" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
          <Field label="Senha" htmlFor="password" required>
            <input id="password" type="password" className="input" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          {error && <Alert kind="danger">{error}</Alert>}
          <Button type="submit" variant="primary" loading={busy}>
            <LogIn size={16} aria-hidden /> Entrar
          </Button>
        </form>
      </div>
    </div>
  );
}
