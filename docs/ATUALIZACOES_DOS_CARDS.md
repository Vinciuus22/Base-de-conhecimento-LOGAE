# Atualizações dos Cards (Jira)

Módulo **interno e somente de consulta**: espelha localmente os cards dos projetos Jira monitorados (inicialmente `CHL` e `RISK1`) e guarda o histórico completo de cada um. Nenhuma operação escreve no Jira, e nenhuma notificação é enviada ao responsável do card.

Acesso: menu **Ambiente interno → Atualizações dos Cards** (`/interno/cards`). Exige a permissão `cards.view` (perfis Administrador e Suporte técnico); `cards.sync` permite "Atualizar agora". Usuários externos recebem 403 em todas as rotas `/api/cards*`.

## Configuração

| Variável | Descrição |
|---|---|
| `JIRA_CARD_PROJECTS` | Projetos monitorados (padrão `CHL,RISK1`). Para incluir outro, basta acrescentar a chave. |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | Acesso à API do Jira (leitura). O usuário da integração precisa de permissão de leitura nos projetos; os dados espelhados refletem o que ele enxerga. |
| `JIRA_WEBHOOK_SECRET` | Segredo do webhook (cabeçalho `X-Jira-Secret` ou `?secret=`). |
| `JIRA_CARDS_SYNC_MINUTES` | Sincronização incremental automática (0 desativa). |
| `JIRA_SHARED_ACCOUNTS` | Contas compartilhadas (accountId, e-mail ou nome). Eventos feitos por elas são marcados "conta compartilhada". |

**Webhook no Jira** (Configurações → Sistema → WebHooks): URL `https://SEU-BACKEND/api/integrations/jira/cards/webhook`, eventos *issue created/updated/deleted* e *comment created/updated/deleted*, filtrando os projetos monitorados. Os eventos são deduplicados (`jira_webhook_events`) e cada evento do histórico tem chave única, então reenvios não duplicam.

## Como o histórico é obtido
- **Sincronização** (`POST /api/cards/sync`, botão "Atualizar agora" ou job periódico): consulta `/rest/api/3/search/jql` com paginação e, por card, `/changelog` e `/comment` paginados. A primeira execução (ou `full: true`) é completa; as seguintes são incrementais (`updated >= -Nm`, com 60 min de sobreposição, sem problema de fuso).
- **Webhook**: grava imediatamente o evento do payload e, se a API estiver configurada, reconcilia o histórico completo do card.
- Falhas temporárias (rede, 429, 5xx) são retentadas com espera crescente (respeitando `Retry-After`); 401/403/404 não são retentadas. Falha geral **não apaga** dados; execuções ficam em `jira_sync_runs` (`success`, `partial`, `failed` e erro). Falhas por card marcam `history_complete = false` e a tela mostra "histórico possivelmente incompleto".
- Os status são os do Jira (listados dinamicamente a partir dos cards); status novos aparecem sozinhos.

## Autor e conta compartilhada
O autor exibido é exatamente o informado pelo Jira (nome + accountId). O responsável atual é mostrado separadamente. Quando o Jira não informa o autor, a tela diz "Autor não disponível". Nada é inferido por horário ou conteúdo.

## Limitações conhecidas
- O Jira não expõe comentários removidos nem versões intermediárias de comentários editados: o módulo registra a remoção (via webhook) e a edição, mas só guarda a última versão do texto.
- Comentários com restrição de visibilidade no Jira são registrados sem o conteúdo.
- O histórico anterior ao primeiro webhook só existe se a API do Jira estiver configurada.
- Testado com respostas simuladas da API do Jira; **valide com cards reais (ex.: CHL-245)** após configurar as credenciais.
