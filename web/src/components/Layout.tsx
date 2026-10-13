import { useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  BookOpen,
  ClipboardList,
  FileStack,
  FolderTree,

  LayoutDashboard,
  Lock,
  LogIn,
  LogOut,
  Megaphone,
  Menu,
  Newspaper,
  ShieldCheck,
  Users,
  Building2,
  Headset,
  Rocket,
  Handshake,
  KanbanSquare,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { ChatWidget } from './ChatWidget';

export function AppShell() {
  const { user, isInternal, logout, config } = useAuth();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const appName = config?.appName ?? 'Base de Conhecimento';

  return (
    <>
      <a href="#conteudo" className="skip-link">
        Pular para o conteúdo
      </a>
      <header className="app-header">
        <div className="app-header-inner">
          <Link to="/" className="brand" aria-label={`${appName} — página inicial`}>
            <span className="brand-logo" aria-hidden>
              <BookOpen size={18} />
            </span>
            <span className="brand-name">{appName}</span>
          </Link>
          <nav className={`main-nav ${open ? 'open' : ''}`} aria-label="Navegação principal" onClick={() => setOpen(false)}>
            <NavLink to="/" end>
              Início
            </NavLink>
            <NavLink to="/busca">Pesquisar</NavLink>
            <NavLink to="/atualizacoes">Atualizações</NavLink>
            {isInternal && <NavLink to="/comunicados">Comunicados</NavLink>}
            {user && <NavLink to="/tickets">Meus tickets</NavLink>}
            {isInternal && <NavLink to="/interno">Ambiente interno</NavLink>}
          </nav>
          <div className="header-actions">
            {user ? (
              <>
                <Link to="/conta" className="small muted" style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: 'none' }} title={`${user.email} — minha conta`}>
                  {user.name}
                </Link>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={async () => {
                    await logout();
                    navigate('/');
                  }}
                >
                  <LogOut size={16} aria-hidden /> Sair
                </button>
              </>
            ) : (
              <Link className="btn btn-sm btn-primary" to={`/entrar?voltar=${encodeURIComponent(location.pathname + location.search)}`}>
                <LogIn size={16} aria-hidden /> Entrar
              </Link>
            )}
            <button type="button" className="btn btn-sm btn-icon menu-toggle" aria-label="Abrir menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              <Menu size={18} aria-hidden />
            </button>
          </div>
        </div>
      </header>
      <main id="conteudo" tabIndex={-1}>
        <Outlet />
      </main>
      <footer className="app-footer">
        <div className="app-footer-inner">
          <span>
            © {new Date().getFullYear()} {appName}
          </span>
          <span>Precisa de ajuda? Use o assistente ou <Link to="/tickets/novo">abra um ticket</Link>.</span>
        </div>
      </footer>
      <ChatWidget />
    </>
  );
}

function SideLink({ to, icon, children, end }: { to: string; icon: ReactNode; children: ReactNode; end?: boolean }) {
  return (
    <NavLink to={to} end={end}>
      {icon}
      {children}
    </NavLink>
  );
}

/** Ambiente interno: o menu exibe somente o que o usuário pode acessar (o backend valida cada operação). */
export function InternalLayout() {
  const { can } = useAuth();
  const content = can('articles.create') || can('articles.edit') || can('articles.edit_others') || can('articles.publish');
  return (
    <div className="internal-layout">
      <nav className="sidebar" aria-label="Ambiente interno">
        <h2>Visão geral</h2>
        <SideLink to="/interno" end icon={<LayoutDashboard size={18} aria-hidden />}>
          Painel
        </SideLink>
        <h2>Conteúdo</h2>
        {(content || can('articles.view_internal')) && (
          <SideLink to="/interno/artigos" icon={<Newspaper size={18} aria-hidden />}>
            Artigos
          </SideLink>
        )}
        {can('categories.manage') && (
          <SideLink to="/interno/categorias" icon={<FolderTree size={18} aria-hidden />}>
            Categorias e sistemas
          </SideLink>
        )}
        {can('announcements.manage') && (
          <SideLink to="/interno/comunicados" icon={<Megaphone size={18} aria-hidden />}>
            Comunicados
          </SideLink>
        )}
        {can('updates.manage') && (
          <SideLink to="/interno/atualizacoes" icon={<Rocket size={18} aria-hidden />}>
            Atualizações (Jira)
          </SideLink>
        )}
        {can('integrations.view') && (
          <SideLink to="/interno/integracoes" icon={<Handshake size={18} aria-hidden />}>
            Integração de Clientes
          </SideLink>
        )}
        {can('cards.view') && (
          <SideLink to="/interno/cards" icon={<KanbanSquare size={18} aria-hidden />}>
            Atualizações dos Cards
          </SideLink>
        )}
        {can('documents.manage') && (
          <SideLink to="/interno/documentos" icon={<FileStack size={18} aria-hidden />}>
            Documentos
          </SideLink>
        )}
        {(can('tickets.support') || can('tickets.manage')) && (
          <>
            <h2>Atendimento</h2>
            <SideLink to="/interno/tickets" icon={<Headset size={18} aria-hidden />}>
              Tickets
            </SideLink>
          </>
        )}
        <SideLink to="/tickets" icon={<ClipboardList size={18} aria-hidden />}>
          Meus tickets
        </SideLink>
        {(can('users.manage') || can('audit.view') || can('locks.release')) && <h2>Administração</h2>}
        {can('users.manage') && (
          <>
            <SideLink to="/interno/usuarios" icon={<Users size={18} aria-hidden />}>
              Usuários e permissões
            </SideLink>
            <SideLink to="/interno/empresas" icon={<Building2 size={18} aria-hidden />}>
              Empresas
            </SideLink>
          </>
        )}
        {can('locks.release') && (
          <SideLink to="/interno/bloqueios" icon={<Lock size={18} aria-hidden />}>
            Bloqueios de edição
          </SideLink>
        )}
        {can('audit.view') && (
          <SideLink to="/interno/auditoria" icon={<ShieldCheck size={18} aria-hidden />}>
            Auditoria
          </SideLink>
        )}
      </nav>
      <div className="internal-main">
        <Outlet />
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, icon }: { title: string; subtitle?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1 className="row" style={{ gap: 10 }}>
          {icon}
          {title}
        </h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="btn-group">{actions}</div>}
    </div>
  );
}

