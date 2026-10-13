# Permissões e segurança

## 1. Modelo de permissões

Permissões efetivas = **(permissões dos perfis ∪ concessões individuais) − revogações
individuais**, filtradas pelo tipo do usuário. Permissões marcadas como “somente
internas” **nunca** têm efeito para usuários externos, mesmo se gravadas no banco.

Ser usuário interno **não concede** nenhuma permissão automaticamente: sem perfil, o
usuário interno não acessa nada além do conteúdo público.

| Chave | Descrição | Somente interno |
|---|---|---|
| `articles.view_internal` | Visualizar artigos e documentos internos | Sim |
| `articles.create` | Criar artigos e salvar rascunhos | Sim |
| `articles.edit` | Editar os próprios artigos | Sim |
| `articles.edit_others` | Editar artigos de outros autores | Sim |
| `articles.publish` | Publicar e alterar artigos publicados | Sim |
| `articles.unpublish` | Despublicar | Sim |
| `articles.archive` | Arquivar e restaurar do arquivo | Sim |
| `articles.history` | Consultar histórico e versões | Sim |
| `categories.manage` | Categorias, sistemas, tags e sinônimos | Sim |
| `announcements.manage` | Cadastrar e publicar comunicados (exclusivos de usuários internos, vinculados a plataformas) | Sim |
| `cards.view` | Consultar Atualizações dos Cards (Jira, somente leitura) | Sim |
| `cards.sync` | Solicitar sincronização manual dos cards | Sim |
| `updates.manage` | Ocultar/exibir atualizações vindas do Jira e ajustar o público alvo | Sim |
| `documents.manage` | Importar, aprovar, reprocessar e remover documentos | Sim |
| `users.manage` | Usuários, empresas, perfis e permissões | Sim |
| `audit.view` | Consultar auditoria | Sim |
| `locks.release` | Liberar bloqueios abandonados | Sim |
| `tickets.support` | Atender tickets sem responsável ou atribuídos a si | Sim |
| `tickets.manage` | Ver todos os tickets e atribuir atendentes | Sim |
| `tickets.view_company` | Ver tickets de outros usuários da mesma empresa | Não |

### Perfis iniciais

| Perfil | Permissões |
|---|---|
| Administrador | Todas as internas (podem ser revogadas individualmente) |
| Editor | view_internal, create, edit, edit_others, history (**sem** publicar) |
| Autor | view_internal, create, edit, history |
| Suporte técnico | view_internal, tickets.support |
| Leitor interno | view_internal |
| Usuário externo | nenhuma permissão administrativa (artigos externos, IA e os próprios tickets) |

Concessões, revogações e alterações de perfil são registradas em `audit_logs` com o
responsável, data, hora, valor anterior e novo. A revogação tem efeito na próxima
requisição (as permissões são lidas do banco a cada requisição).

## 2. Regras de acesso (resumo de `server/src/auth/policies.ts`)

- **Artigo publicado externo**: qualquer usuário (visitantes, se `PUBLIC_ANONYMOUS_ACCESS=true`).
- **Artigo publicado interno**: somente internos com `articles.view_internal`.
- **Rascunho/despublicado/arquivado**: somente internos — o autor (com criar/editar) ou
  quem tem editar de outros/publicar/despublicar/arquivar.
- Recursos sem acesso retornam **404** (não revelam existência).
- **Arquivos** herdam o acesso do recurso proprietário (artigo, comunicado, ticket,
  observação interna, documento). Uploads ainda não vinculados: apenas quem enviou.
- **Tickets**: o solicitante; usuários da mesma empresa somente com
  `tickets.view_company`; suporte vê tickets sem responsável ou atribuídos a si;
  administração (`tickets.manage`) vê todos. Tentativas negadas são auditadas
  (`ticket.access_denied`).
- **Observações internas** ficam em tabela separada e nunca são consultadas na visão do cliente.
- **Documentos**: somente após aprovação, conforme a visibilidade; gestores veem todos.

## 3. Controles implementados

| Tema | Implementação |
|---|---|
| Senhas | scrypt (N=2^15), política mínima (10 caracteres, letras e números), bloqueio de 15 min após 5 falhas, tempo de resposta equalizado para e-mails inexistentes |
| Sessão | Token aleatório de 256 bits em cookie `httpOnly`, `SameSite=Lax`, `Secure` em produção; armazenado como hash SHA-256; expiração deslizante; encerramento ao trocar senha/desativar usuário |
| CSRF | Token por sessão exigido no cabeçalho `X-CSRF-Token` em requisições que alteram estado; verificação do cabeçalho `Origin` |
| XSS | Conteúdo rico sanitizado no servidor com lista de permissões (tags, atributos, estilos, esquemas de URL); imagens somente de `/api/files/…`; vídeos armazenados apenas pelo ID; reinterpretação pelo esquema do editor no navegador; textos de tickets sempre renderizados com escape; CSP restritiva |
| Injeção de SQL | Somente consultas parametrizadas; consultas de pesquisa montadas a partir de lexemas validados |
| Uploads | Tipo real por assinatura (magic bytes); SVG, executáveis e formatos não listados rejeitados; limites por tipo; nomes sanitizados; respostas com `nosniff`, `Content-Disposition` e CSP `sandbox` |
| Armazenamento | Diretório privado (fora da pasta pública) ou bucket S3 privado com URLs pré-assinadas de curta duração, emitidas após a autorização |
| Cache | `private, no-store` para conteúdo restrito; artigos sempre `no-store` na API |
| Limitação de requisições | Login, chat, auxílio da IA e abertura de tickets |
| Auditoria | Login/logout/falhas, permissões, perfis, usuários, artigos, bloqueios, tickets, documentos, arquivos; registros imutáveis; campos sensíveis removidos (`password`, `token`, `secret`, `apiKey`…) |
| Logs | Cookies, `Authorization` e `X-CSRF-Token` removidos dos logs |
| IA | Isolamento por consulta autorizada no backend (não pelo prompt); conteúdo tratado como dado; IDs de fontes validados; URLs geradas removidas |
| Cabeçalhos | Helmet (CSP, `frame-ancestors 'none'`, `Referrer-Policy`, HSTS via proxy) |

## 4. LGPD

- **Minimização**: o chat salva somente o necessário; conversas são excluídas após
  `AI_CONVERSATION_RETENTION_DAYS` (padrão 180 dias).
- **Direito de eliminação**: “Anonimizar (LGPD)” substitui nome e e-mail, bloqueia o
  acesso, encerra sessões e exclui conversas com IA, preservando a integridade de
  tickets, artigos e auditoria (registros necessários para cumprimento de obrigações).
- **Envio à IA**: apenas trechos da Base de Conhecimento e o texto digitado pelo usuário
  são enviados ao provedor (Anthropic). Os dados do ticket não são enviados ao chat. Avalie
  o contrato/DPA com o provedor e informe os usuários na política de privacidade.
- **Sugestão de artigo a partir de ticket**: gera rascunho **interno** com aviso para
  remover dados de clientes antes de publicar.
- **Política de retenção sugerida** (a formalizar pelo controlador): sessões expiradas
  removidas a cada 10 min; tickets e auditoria mantidos pelo prazo legal/contratual;
  documentos removidos têm o arquivo apagado e o registro mantido para rastreabilidade.

## 5. Recomendações para produção

- HTTPS obrigatório com `COOKIE_SECURE=true` e `TRUST_PROXY=true` atrás de proxy.
- `APP_SECRET` forte, segredos em cofre (não no repositório).
- Usuário do banco sem privilégio de superusuário para a aplicação (as *triggers* de
  imutabilidade só podem ser desativadas por proprietários/superusuários).
- Backups do PostgreSQL e do armazenamento de arquivos.
- Com múltiplas instâncias, use armazenamento de rate limit compartilhado (Redis) — o
  padrão é em memória por instância.
