# Frontend — tema e telas do handoff Logaz

Referência: pacote `design_handoff_base_conhecimento_logaz` (README, TELAS, COMPORTAMENTO). O tema é aplicado pelos tokens de `web/src/styles/global.css` (seção "Tema Logaz"); a logo está em `web/public/logaz-logo.png`.

## Implementado conforme o handoff
Login (sem cabeçalho/assistente) · cabeçalho verde com logo e navegação (Início, Atualizações, Comunicados, Meus tickets, Ambiente interno) · Home com busca e resultados na própria página (a rota `/busca` redireciona), chips de sistema, categorias e listas por perfil ("Mais acessados por você" usa o novo histórico de leitura) · Atualizações (interno vê link do Jira e público; externo só o conteúdo) · Comunicados públicos (publicados Externos) e gestão interna · Meus tickets (indicadores + pendentes/em aberto + finalizados com busca) · Painel interno · Artigos agrupados por categoria · Editor em tela cheia · Atualizações dos Cards (chips, `statusTone`, faixa de sincronização) · Integração de Clientes (indicadores, cards/tabela, formulários, histórico e auditoria) · Documentos de apoio (arquivo ou link; aba separada para a importação para IA) · Tickets (fila em 3 seções) · Usuários e permissões (mestre/detalhe com marcação imediata) · Empresas (acesso multi-empresa e sistemas contratados) · Auditoria (tela, ação, item, IP, "Ver alterações" antes/depois).

## Diferenças e pendências conscientes
- "Nova permissão do sistema": as permissões são definidas em código (`shared/src/permissions.ts`), não cadastradas em tela.
- "Esqueceu sua senha?": não há fluxo de redefinição por e-mail; a tela orienta procurar o administrador.
- Categorias e sistemas mantém as abas (categorias, sistemas, tags e sinônimos) já existentes.
- A barra superior do editor (Histórico/Salvar rascunho/Publicar) seguem o editor já existente.
