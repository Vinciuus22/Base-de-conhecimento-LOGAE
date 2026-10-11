import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { LogIn } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { errorMessage } from '../lib/api';
import { Alert, Button, Field } from '../components/ui';

export function LoginPage() {
  const { login, user, config } = useAuth();
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
        {!!config?.testAccounts?.length && (
          <div className="alert alert-info" style={{ marginTop: 16 }} data-testid="test-accounts">
            <strong>Contas de teste</strong>
            <p className="tiny" style={{ margin: '4px 0 8px' }}>Ambiente de testes — desative em produção.</p>
            <div className="stack" style={{ gap: 6 }}>
              {config.testAccounts.map((a) => (
                <button
                  key={a.email}
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setEmail(a.email);
                    setPassword(a.password);
                  }}
                >
                  {a.label}: {a.email}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
