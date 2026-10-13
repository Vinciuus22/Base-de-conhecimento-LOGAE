import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { errorMessage } from '../lib/api';

/** Tela de entrada (sem cabeçalho global nem assistente), conforme o design Logaz. */
export function LoginPage() {
  const { login, user, config } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const back = params.get('voltar');
  const target = back && back.startsWith('/') && !back.startsWith('//') ? back : '/';

  if (user) return <Navigate to={target} replace />;

  return (
    <div className="login-page">
      <img src="/logaz-logo.png" alt={config?.appName ?? 'Logaz'} className="login-logo" />
      <main className="login-card" id="conteudo">
        <h1>Entrar na sua conta</h1>
        <form
          className="stack"
          style={{ gap: 18 }}
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
          <div className="field">
            <label htmlFor="email">Login</label>
            <input id="email" type="email" className="input login-input" placeholder="Digite seu e-mail de acesso" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="password">Senha</label>
            <div className="login-password">
              <input id="password" type={show ? 'text' : 'password'} className="input login-input" placeholder="Digite sua senha" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              <button type="button" aria-label={show ? 'Ocultar a senha digitada' : 'Exibir a senha digitada'} aria-pressed={show} onClick={() => setShow(!show)}>
                {show ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
              </button>
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <button type="button" className="link-button" onClick={() => setForgot(!forgot)} aria-expanded={forgot}>
              Esqueceu sua senha?
            </button>
          </div>
          {forgot && (
            <p role="status" className="banner banner-info">
              Para redefinir sua senha, entre em contato com o administrador da sua conta.
            </p>
          )}
          {error && (
            <p role="alert" className="banner banner-error">
              {error}
            </p>
          )}
          <button type="submit" className="login-submit" disabled={busy} aria-busy={busy}>
            {busy ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
        {!!config?.testAccounts?.length && (
          <div className="banner banner-info" style={{ marginTop: 20 }} data-testid="test-accounts">
            <strong>Contas de teste</strong>
            <p className="tiny" style={{ margin: '4px 0 8px' }}>Ambiente de testes — desative em produção.</p>
            <div className="stack" style={{ gap: 6 }}>
              {config.testAccounts.map((a) => (
                <button key={a.email} type="button" className="btn btn-sm" onClick={() => { setEmail(a.email); setPassword(a.password); }}>
                  {a.label}: {a.email}
                </button>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
