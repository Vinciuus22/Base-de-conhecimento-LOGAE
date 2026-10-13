/**
 * Catálogo de permissões da aplicação.
 *
 * As permissões são SEMPRE verificadas no backend. O frontend utiliza este
 * catálogo apenas para exibir ou ocultar ações (conveniência visual).
 */

export const PERMISSIONS = {
  ARTICLES_VIEW_INTERNAL: 'articles.view_internal',
  ARTICLES_CREATE: 'articles.create',
  ARTICLES_EDIT: 'articles.edit',
  ARTICLES_EDIT_OTHERS: 'articles.edit_others',
  ARTICLES_PUBLISH: 'articles.publish',
  ARTICLES_UNPUBLISH: 'articles.unpublish',
  ARTICLES_ARCHIVE: 'articles.archive',
  ARTICLES_HISTORY: 'articles.history',
  CATEGORIES_MANAGE: 'categories.manage',
  ANNOUNCEMENTS_MANAGE: 'announcements.manage',
  UPDATES_MANAGE: 'updates.manage',
  INTEGRATIONS_VIEW: 'integrations.view',
  INTEGRATIONS_CREATE: 'integrations.create',
  INTEGRATIONS_EDIT: 'integrations.edit',
  INTEGRATIONS_LOG: 'integrations.log',
  INTEGRATIONS_STATUS: 'integrations.status',
  INTEGRATIONS_FINISH: 'integrations.finish',
  INTEGRATIONS_REOPEN: 'integrations.reopen',
  INTEGRATIONS_HISTORY: 'integrations.history',
  INTEGRATIONS_ARCHIVE: 'integrations.archive',
  INTEGRATIONS_ADMIN: 'integrations.admin',
  CARDS_VIEW: 'cards.view',
  CARDS_SYNC: 'cards.sync',
  USERS_MANAGE: 'users.manage',
  DOCUMENTS_MANAGE: 'documents.manage',
  TICKETS_SUPPORT: 'tickets.support',
  TICKETS_MANAGE: 'tickets.manage',
  TICKETS_VIEW_COMPANY: 'tickets.view_company',
  AUDIT_VIEW: 'audit.view',
  LOCKS_RELEASE: 'locks.release',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export interface PermissionDefinition {
  key: PermissionKey;
  label: string;
  description: string;
  /** Quando verdadeiro, a permissão nunca tem efeito para usuários externos. */
  internalOnly: boolean;
  group: 'Artigos' | 'Conteúdo' | 'Administração' | 'Tickets' | 'Integração de Clientes';
}

export const PERMISSION_DEFINITIONS: PermissionDefinition[] = [
  { key: 'articles.view_internal', label: 'Visualizar artigos internos', description: 'Consultar artigos e documentos classificados como internos.', internalOnly: true, group: 'Artigos' },
  { key: 'articles.create', label: 'Criar artigos', description: 'Criar novos artigos e salvar rascunhos.', internalOnly: true, group: 'Artigos' },
  { key: 'articles.edit', label: 'Editar artigos', description: 'Editar os próprios artigos.', internalOnly: true, group: 'Artigos' },
  { key: 'articles.edit_others', label: 'Editar artigos de outros autores', description: 'Editar artigos criados por outros usuários.', internalOnly: true, group: 'Artigos' },
  { key: 'articles.publish', label: 'Publicar artigos', description: 'Publicar artigos e alterar artigos já publicados.', internalOnly: true, group: 'Artigos' },
  { key: 'articles.unpublish', label: 'Despublicar artigos', description: 'Retirar artigos de publicação.', internalOnly: true, group: 'Artigos' },
  { key: 'articles.archive', label: 'Arquivar artigos', description: 'Arquivar e restaurar artigos arquivados.', internalOnly: true, group: 'Artigos' },
  { key: 'articles.history', label: 'Consultar histórico de artigos', description: 'Visualizar o histórico de alterações e versões dos artigos.', internalOnly: true, group: 'Artigos' },
  { key: 'categories.manage', label: 'Gerenciar categorias', description: 'Gerenciar categorias, sistemas, tags e sinônimos de pesquisa.', internalOnly: true, group: 'Conteúdo' },
  { key: 'announcements.manage', label: 'Gerenciar comunicados', description: 'Cadastrar e publicar atualizações e comunicados.', internalOnly: true, group: 'Conteúdo' },
  { key: 'updates.manage', label: 'Gerenciar atualizações', description: 'Ocultar/exibir atualizações vindas do Jira, ajustar o público e sincronizar com o Jira.', internalOnly: true, group: 'Conteúdo' },
  { key: 'cards.view', label: 'Consultar atualizações dos cards', description: 'Consultar os cards do Jira monitorados e o histórico de alterações (somente leitura).', internalOnly: true, group: 'Conteúdo' },
  { key: 'cards.sync', label: 'Sincronizar cards do Jira', description: 'Solicitar a sincronização manual dos cards com o Jira.', internalOnly: true, group: 'Conteúdo' },
  { key: 'integrations.view', label: 'Consultar integrações', description: 'Consultar os cards de integração de clientes e as atividades.', internalOnly: true, group: 'Integração de Clientes' },
  { key: 'integrations.create', label: 'Criar integrações', description: 'Cadastrar novos cards de integração.', internalOnly: true, group: 'Integração de Clientes' },
  { key: 'integrations.edit', label: 'Editar integrações', description: 'Alterar os dados cadastrais dos cards.', internalOnly: true, group: 'Integração de Clientes' },
  { key: 'integrations.log', label: 'Registrar atividades', description: 'Adicionar registros ao histórico do acompanhamento.', internalOnly: true, group: 'Integração de Clientes' },
  { key: 'integrations.status', label: 'Alterar status', description: 'Alterar o status entre Início e Acompanhamento.', internalOnly: true, group: 'Integração de Clientes' },
  { key: 'integrations.finish', label: 'Finalizar integrações', description: 'Finalizar integrações e editar dados de finalização.', internalOnly: true, group: 'Integração de Clientes' },
  { key: 'integrations.reopen', label: 'Reabrir integrações', description: 'Reabrir integrações finalizadas.', internalOnly: true, group: 'Integração de Clientes' },
  { key: 'integrations.history', label: 'Consultar histórico de alterações', description: 'Consultar o histórico de alterações cadastrais.', internalOnly: true, group: 'Integração de Clientes' },
  { key: 'integrations.archive', label: 'Arquivar integrações', description: 'Arquivar e restaurar cards de integração.', internalOnly: true, group: 'Integração de Clientes' },
  { key: 'integrations.admin', label: 'Administrar integrações', description: 'Gerenciar tipos de atividade e corrigir/remover atividades de outros usuários.', internalOnly: true, group: 'Integração de Clientes' },
  { key: 'documents.manage', label: 'Gerenciar documentos', description: 'Importar, aprovar, reprocessar e remover documentos.', internalOnly: true, group: 'Conteúdo' },
  { key: 'users.manage', label: 'Gerenciar usuários', description: 'Gerenciar usuários, empresas, perfis e permissões.', internalOnly: true, group: 'Administração' },
  { key: 'audit.view', label: 'Consultar auditoria', description: 'Consultar os registros de auditoria.', internalOnly: true, group: 'Administração' },
  { key: 'locks.release', label: 'Liberar bloqueios de edição', description: 'Liberar bloqueios de edição abandonados.', internalOnly: true, group: 'Administração' },
  { key: 'tickets.support', label: 'Atender tickets', description: 'Responder clientes, alterar status e registrar soluções nos tickets autorizados.', internalOnly: true, group: 'Tickets' },
  { key: 'tickets.manage', label: 'Administrar tickets', description: 'Consultar todos os tickets e atribuí-los a atendentes.', internalOnly: true, group: 'Tickets' },
  { key: 'tickets.view_company', label: 'Consultar tickets da empresa', description: 'Consultar os tickets abertos por outros usuários da mesma empresa.', internalOnly: false, group: 'Tickets' },
];

export const ALL_PERMISSION_KEYS: PermissionKey[] = PERMISSION_DEFINITIONS.map((p) => p.key);

export function isPermissionKey(value: string): value is PermissionKey {
  return (ALL_PERMISSION_KEYS as string[]).includes(value);
}

export const ROLE_KEYS = ['admin', 'editor', 'author', 'support', 'integrations', 'internal_reader', 'external'] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export interface RoleDefinition {
  key: RoleKey;
  name: string;
  description: string;
  userType: 'internal' | 'external';
  permissions: PermissionKey[];
}

export const ROLE_DEFINITIONS: RoleDefinition[] = [
  {
    key: 'admin',
    name: 'Administrador',
    description: 'Gerencia usuários, permissões, categorias e integrações; consulta auditoria.',
    userType: 'internal',
    permissions: [...ALL_PERMISSION_KEYS.filter((k) => k !== 'tickets.view_company')],
  },
  {
    key: 'editor',
    name: 'Editor',
    description: 'Cria e edita artigos e mídias. Publica somente com a permissão específica.',
    userType: 'internal',
    permissions: ['articles.view_internal', 'articles.create', 'articles.edit', 'articles.edit_others', 'articles.history'],
  },
  {
    key: 'author',
    name: 'Autor',
    description: 'Cria artigos e edita os próprios rascunhos.',
    userType: 'internal',
    permissions: ['articles.view_internal', 'articles.create', 'articles.edit', 'articles.history'],
  },
  {
    key: 'support',
    name: 'Suporte técnico',
    description: 'Atende tickets, responde clientes e registra soluções.',
    userType: 'internal',
    permissions: ['articles.view_internal', 'tickets.support', 'cards.view'],
  },
  {
    key: 'integrations',
    name: 'Integração de clientes',
    description: 'Acompanha integrações de clientes: cria, edita, registra atividades, altera status e finaliza.',
    userType: 'internal',
    permissions: ['articles.view_internal', 'integrations.view', 'integrations.create', 'integrations.edit', 'integrations.log', 'integrations.status', 'integrations.finish', 'integrations.history'],
  },
  {
    key: 'internal_reader',
    name: 'Leitor interno',
    description: 'Consulta artigos autorizados, pesquisa e utiliza o chat com IA.',
    userType: 'internal',
    permissions: ['articles.view_internal'],
  },
  {
    key: 'external',
    name: 'Usuário externo',
    description: 'Consulta artigos externos, utiliza a IA e acompanha os próprios tickets.',
    userType: 'external',
    permissions: [],
  },
];

export type UserType = 'internal' | 'external';

/** Calcula as permissões efetivas: (perfis ∪ concessões) − revogações, filtradas pelo tipo do usuário. */
export function computeEffectivePermissions(
  userType: UserType,
  rolePermissions: string[],
  grants: string[],
  denies: string[],
): PermissionKey[] {
  const set = new Set<string>([...rolePermissions, ...grants]);
  for (const d of denies) set.delete(d);
  return PERMISSION_DEFINITIONS.filter((p) => set.has(p.key) && (userType === 'internal' || !p.internalOnly)).map(
    (p) => p.key,
  );
}
