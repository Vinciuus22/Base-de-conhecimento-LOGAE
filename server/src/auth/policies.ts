/**
 * Políticas de autorização centralizadas.
 *
 * Toda rota protegida usa estas funções no backend. Elas recebem o usuário
 * autenticado (ou null para visitantes) e o estado ATUAL do recurso, lido do
 * banco na própria requisição.
 */
import { config } from '../config.js';
import type { AuthUser } from './context.js';

export interface ArticleAccessInfo {
  status: string;
  visibility: string;
  author_id: string;
}

/** Visitante anônimo só acessa conteúdo público se a configuração permitir. */
export function anonymousAllowed(user: AuthUser | null): boolean {
  return !!user || config().PUBLIC_ANONYMOUS_ACCESS;
}

function canSeeUnpublished(user: AuthUser, article: ArticleAccessInfo): boolean {
  const p = user.permissions;
  if (article.author_id === user.id && (p.has('articles.create') || p.has('articles.edit'))) return true;
  return p.has('articles.edit_others') || p.has('articles.publish') || p.has('articles.unpublish') || p.has('articles.archive');
}

export function canViewArticle(user: AuthUser | null, article: ArticleAccessInfo): boolean {
  if (article.status === 'published') {
    if (article.visibility === 'external') return anonymousAllowed(user);
    return !!user && user.userType === 'internal' && user.permissions.has('articles.view_internal');
  }
  // Rascunhos, despublicados e arquivados: somente equipe interna autorizada.
  if (!user || user.userType !== 'internal') return false;
  if (article.visibility === 'internal' && !user.permissions.has('articles.view_internal')) return false;
  return canSeeUnpublished(user, article);
}

/** Permissão para EDITAR o conteúdo (verificada também ao adquirir o bloqueio e ao salvar). */
export function canEditArticle(user: AuthUser | null, article: ArticleAccessInfo): { ok: boolean; reason?: string } {
  if (!user || user.userType !== 'internal') return { ok: false, reason: 'Somente usuários internos podem editar artigos.' };
  const p = user.permissions;
  const own = article.author_id === user.id;
  if (!((own && p.has('articles.edit')) || p.has('articles.edit_others'))) {
    return { ok: false, reason: own ? 'Você não possui permissão para editar artigos.' : 'Você não possui permissão para editar artigos de outros autores.' };
  }
  if (article.status === 'archived') return { ok: false, reason: 'Artigos arquivados precisam ser restaurados antes da edição.' };
  if (article.status === 'published' && !p.has('articles.publish')) {
    return { ok: false, reason: 'Alterações em artigos publicados entram no ar imediatamente e exigem a permissão de publicação.' };
  }
  if (article.visibility === 'internal' && !p.has('articles.view_internal')) {
    return { ok: false, reason: 'Você não possui acesso a artigos internos.' };
  }
  return { ok: true };
}

export function canViewArticleHistory(user: AuthUser | null, article: ArticleAccessInfo): boolean {
  if (!user || user.userType !== 'internal') return false;
  if (!user.permissions.has('articles.history')) return false;
  return canViewArticle(user, article) || canEditArticle(user, article).ok;
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------
export interface TicketAccessInfo {
  requester_id: string;
  company_id: string;
  assignee_id: string | null;
}

/** Atendimento: suporte vê tickets sem responsável ou atribuídos a si; administração vê todos. */
export function canSupportTicket(user: AuthUser | null, ticket: TicketAccessInfo): boolean {
  if (!user || user.userType !== 'internal') return false;
  if (user.permissions.has('tickets.manage')) return true;
  return user.permissions.has('tickets.support') && (ticket.assignee_id === null || ticket.assignee_id === user.id);
}

/** Acesso como solicitante: o próprio ticket ou, com regra explícita, os da mesma empresa. */
export function canViewTicketAsCustomer(user: AuthUser | null, ticket: TicketAccessInfo): boolean {
  if (!user) return false;
  if (ticket.requester_id === user.id) return true;
  return user.permissions.has('tickets.view_company') && !!user.companyId && user.companyId === ticket.company_id;
}

export function canViewTicket(user: AuthUser | null, ticket: TicketAccessInfo): boolean {
  return canViewTicketAsCustomer(user, ticket) || canSupportTicket(user, ticket);
}

// ---------------------------------------------------------------------------
// Documentos importados
// ---------------------------------------------------------------------------
export interface DocumentAccessInfo {
  visibility: string;
  review_status: string;
  removed_at: Date | null;
}

export function canViewDocument(user: AuthUser | null, doc: DocumentAccessInfo): boolean {
  if (doc.removed_at) return !!user && user.permissions.has('documents.manage');
  if (user?.permissions.has('documents.manage')) return true;
  // Documentos só ficam disponíveis após revisão e aprovação.
  if (doc.review_status !== 'approved') return false;
  if (doc.visibility === 'external') return anonymousAllowed(user);
  return !!user && user.userType === 'internal' && user.permissions.has('articles.view_internal');
}

// ---------------------------------------------------------------------------
// Comunicados
// ---------------------------------------------------------------------------
export interface AnnouncementAccessInfo {
  status: string;
  visibility: string;
}

export function canViewAnnouncement(user: AuthUser | null, a: AnnouncementAccessInfo): boolean {
  if (user?.permissions.has('announcements.manage')) return true;
  if (a.status !== 'published') return false;
  if (a.visibility === 'external') return anonymousAllowed(user);
  return !!user && user.userType === 'internal' && user.permissions.has('articles.view_internal');
}
