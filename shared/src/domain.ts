/** Enumerações e regras de domínio compartilhadas entre backend e frontend. */

export const ARTICLE_STATUSES = ['draft', 'published', 'unpublished', 'archived'] as const;
export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];
export const ARTICLE_STATUS_LABELS: Record<ArticleStatus, string> = {
  draft: 'Rascunho',
  published: 'Publicado',
  unpublished: 'Despublicado',
  archived: 'Arquivado',
};

export const VISIBILITIES = ['internal', 'external'] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export const VISIBILITY_LABELS: Record<Visibility, string> = {
  internal: 'Interno',
  external: 'Externo',
};

export const ARTICLE_OPERATIONS = [
  'create',
  'update',
  'publish',
  'unpublish',
  'visibility_change',
  'archive',
  'unarchive',
  'restore_version',
  'save_rejected',
] as const;
export type ArticleOperation = (typeof ARTICLE_OPERATIONS)[number];
export const ARTICLE_OPERATION_LABELS: Record<ArticleOperation, string> = {
  create: 'Criação',
  update: 'Edição',
  publish: 'Publicação',
  unpublish: 'Despublicação',
  visibility_change: 'Alteração de visibilidade',
  archive: 'Arquivamento',
  unarchive: 'Restauração do arquivo',
  restore_version: 'Restauração de versão',
  save_rejected: 'Salvamento rejeitado',
};

export const CALLOUT_TYPES = ['atencao', 'alerta', 'importante', 'dica', 'info'] as const;
export type CalloutType = (typeof CALLOUT_TYPES)[number];
export const CALLOUT_LABELS: Record<CalloutType, string> = {
  atencao: 'Atenção',
  alerta: 'Alerta',
  importante: 'Importante',
  dica: 'Dica',
  info: 'Informação',
};

export const TICKET_STATUSES = [
  'open',
  'triage',
  'in_progress',
  'waiting_user',
  'waiting_technical',
  'resolved',
  'closed',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  open: 'Aberto',
  triage: 'Em triagem',
  in_progress: 'Em atendimento',
  waiting_user: 'Aguardando usuário',
  waiting_technical: 'Aguardando equipe técnica',
  resolved: 'Resolvido',
  closed: 'Fechado',
};

/** Transições permitidas para a equipe de suporte. */
export const SUPPORT_STATUS_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  open: ['triage', 'in_progress', 'waiting_user', 'waiting_technical', 'resolved', 'closed'],
  triage: ['in_progress', 'waiting_user', 'waiting_technical', 'resolved', 'closed'],
  in_progress: ['triage', 'waiting_user', 'waiting_technical', 'resolved', 'closed'],
  waiting_user: ['triage', 'in_progress', 'waiting_technical', 'resolved', 'closed'],
  waiting_technical: ['in_progress', 'waiting_user', 'resolved'],
  resolved: ['in_progress', 'closed'],
  closed: ['triage'],
};

export const TICKET_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export const TICKET_PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: 'Baixa',
  medium: 'Média',
  high: 'Alta',
  critical: 'Crítica',
};

export const TICKET_REQUEST_TYPES = ['incident', 'question', 'request', 'improvement'] as const;
export type TicketRequestType = (typeof TICKET_REQUEST_TYPES)[number];
export const TICKET_REQUEST_TYPE_LABELS: Record<TicketRequestType, string> = {
  incident: 'Incidente / erro',
  question: 'Dúvida',
  request: 'Solicitação',
  improvement: 'Sugestão de melhoria',
};

/** Tipos de mensagens públicas do ticket (visíveis ao cliente). */
export const TICKET_MESSAGE_KINDS = ['customer_message', 'support_reply', 'info_request', 'solution'] as const;
export type TicketMessageKind = (typeof TICKET_MESSAGE_KINDS)[number];
export const TICKET_MESSAGE_KIND_LABELS: Record<TicketMessageKind, string> = {
  customer_message: 'Mensagem do usuário',
  support_reply: 'Resposta do suporte',
  info_request: 'Solicitação de informações',
  solution: 'Solução aplicada',
};

export const DOCUMENT_STATUSES = ['pending', 'processing', 'processed', 'processed_with_warnings', 'failed'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];
export const DOCUMENT_STATUS_LABELS: Record<DocumentStatus, string> = {
  pending: 'Aguardando processamento',
  processing: 'Em processamento',
  processed: 'Processado',
  processed_with_warnings: 'Processado com avisos',
  failed: 'Falha no processamento',
};

export const DOCUMENT_REVIEW_STATUSES = ['pending_review', 'approved', 'rejected'] as const;
export type DocumentReviewStatus = (typeof DOCUMENT_REVIEW_STATUSES)[number];
export const DOCUMENT_REVIEW_LABELS: Record<DocumentReviewStatus, string> = {
  pending_review: 'Aguardando revisão',
  approved: 'Aprovado',
  rejected: 'Rejeitado',
};

export const ANNOUNCEMENT_CATEGORIES = ['novidade', 'alteracao', 'manutencao', 'comunicado'] as const;
export type AnnouncementCategory = (typeof ANNOUNCEMENT_CATEGORIES)[number];
export const ANNOUNCEMENT_CATEGORY_LABELS: Record<AnnouncementCategory, string> = {
  novidade: 'Novidade',
  alteracao: 'Alteração de funcionalidade',
  manutencao: 'Manutenção',
  comunicado: 'Comunicado',
};

/** Mensagem padrão quando a IA não encontra uma solução fundamentada. */
export const AI_NO_ANSWER_MESSAGE =
  'Não encontrei na Base de Conhecimento uma solução confirmada para essa situação. Posso ajudar você a abrir um ticket para que a equipe de suporte técnico analise o problema.';

/** Monta a mensagem de bloqueio de edição com os dados reais do responsável. */
export function buildLockMessage(userName: string, date: string, time: string): string {
  return `Este artigo está sendo editado por ${userName} desde ${date} às ${time}. Para evitar alterações conflitantes, a edição está temporariamente bloqueada. Tente novamente quando o artigo estiver disponível.`;
}
