import type { ReactNode } from 'react';
import { Link, Navigate, createBrowserRouter, useLocation } from 'react-router-dom';
import type { PermissionKey } from '@shared/permissions';
import { useAuth } from './context/AuthContext';
import { AppShell, InternalLayout } from './components/Layout';
import { Empty, Spinner } from './components/ui';
import { HomePage } from './pages/Home';
import { SearchPage } from './pages/Search';
import { ArticlePage } from './pages/Article';
import { LoginPage } from './pages/Login';
import { AnnouncementEditorPage, AnnouncementsManagePage, AnnouncementsPage, AnnouncementViewPage } from './pages/Announcements';
import { MyTicketsPage } from './pages/tickets/MyTickets';
import { NewTicketPage } from './pages/tickets/NewTicket';
import { TicketDetailPage } from './pages/tickets/TicketDetail';
import { ArticleEditorPage } from './pages/internal/ArticleEditor';
import { ArticleHistoryPage } from './pages/internal/ArticleHistory';
import { ArticlesListPage, AuditPage, DashboardPage, LocksPage } from './pages/internal/AdminPages';
import { CompaniesPage, UserDetailPage, UsersPage } from './pages/internal/UsersPages';
import { TaxonomyPage } from './pages/internal/TaxonomyPage';
import { DocumentDetailPage, DocumentsPage, DocumentViewPage } from './pages/internal/DocumentsPages';
import { SupportQueuePage } from './pages/support/SupportQueue';
import { SupportTicketPage } from './pages/support/SupportTicket';

/**
 * Proteção de rotas na interface (conveniência de navegação). A segurança real
 * é garantida pelo backend, que valida autenticação e permissões em cada requisição.
 */
function RequireInternal({ children, any }: { children: ReactNode; any?: PermissionKey[] }) {
  const { user, loading, isInternal, can } = useAuth();
  const location = useLocation();
  if (loading) return <Spinner />;
  if (!user) return <Navigate to={`/entrar?voltar=${encodeURIComponent(location.pathname)}`} replace />;
  if (!isInternal || (any && !any.some((p) => can(p)))) {
    return (
      <div className="page page-narrow">
        <Empty title="Acesso não autorizado">
          <p>Você não possui permissão para acessar esta área.</p>
          <Link to="/" className="btn">
            Voltar ao início
          </Link>
        </Empty>
      </div>
    );
  }
  return <>{children}</>;
}

function NotFound() {
  return (
    <div className="page page-narrow">
      <Empty title="Página não encontrada">
        <Link to="/" className="btn">
          Voltar ao início
        </Link>
      </Empty>
    </div>
  );
}

export const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/busca', element: <SearchPage /> },
      { path: '/artigos/:slug', element: <ArticlePage /> },
      { path: '/comunicados', element: <AnnouncementsPage /> },
      { path: '/comunicados/:id', element: <AnnouncementViewPage /> },
      { path: '/documentos/:id', element: <DocumentViewPage /> },
      { path: '/entrar', element: <LoginPage /> },
      { path: '/tickets', element: <MyTicketsPage /> },
      { path: '/tickets/novo', element: <NewTicketPage /> },
      { path: '/tickets/:id', element: <TicketDetailPage /> },
      {
        path: '/interno',
        element: (
          <RequireInternal>
            <InternalLayout />
          </RequireInternal>
        ),
        children: [
          { index: true, element: <DashboardPage /> },
          { path: 'artigos', element: <ArticlesListPage /> },
          {
            path: 'artigos/novo',
            element: (
              <RequireInternal any={['articles.create']}>
                <ArticleEditorPage />
              </RequireInternal>
            ),
          },
          {
            path: 'artigos/:id/editar',
            element: (
              <RequireInternal any={['articles.edit', 'articles.edit_others']}>
                <ArticleEditorPage />
              </RequireInternal>
            ),
          },
          {
            path: 'artigos/:id/historico',
            element: (
              <RequireInternal any={['articles.history']}>
                <ArticleHistoryPage />
              </RequireInternal>
            ),
          },
          { path: 'categorias', element: <RequireInternal any={['categories.manage']}><TaxonomyPage /></RequireInternal> },
          { path: 'comunicados', element: <RequireInternal any={['announcements.manage']}><AnnouncementsManagePage /></RequireInternal> },
          { path: 'comunicados/novo', element: <RequireInternal any={['announcements.manage']}><AnnouncementEditorPage /></RequireInternal> },
          { path: 'comunicados/:id', element: <RequireInternal any={['announcements.manage']}><AnnouncementEditorPage /></RequireInternal> },
          { path: 'documentos', element: <RequireInternal any={['documents.manage']}><DocumentsPage /></RequireInternal> },
          { path: 'documentos/:id', element: <RequireInternal any={['documents.manage']}><DocumentDetailPage /></RequireInternal> },
          { path: 'tickets', element: <RequireInternal any={['tickets.support', 'tickets.manage']}><SupportQueuePage /></RequireInternal> },
          { path: 'tickets/:id', element: <RequireInternal any={['tickets.support', 'tickets.manage']}><SupportTicketPage /></RequireInternal> },
          { path: 'usuarios', element: <RequireInternal any={['users.manage']}><UsersPage /></RequireInternal> },
          { path: 'usuarios/:id', element: <RequireInternal any={['users.manage']}><UserDetailPage /></RequireInternal> },
          { path: 'empresas', element: <RequireInternal any={['users.manage']}><CompaniesPage /></RequireInternal> },
          { path: 'bloqueios', element: <RequireInternal any={['locks.release']}><LocksPage /></RequireInternal> },
          { path: 'auditoria', element: <RequireInternal any={['audit.view']}><AuditPage /></RequireInternal> },
        ],
      },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
