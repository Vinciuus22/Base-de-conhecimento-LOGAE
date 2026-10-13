# Integração de Clientes

Módulo **interno** (`/interno/integracoes`) para acompanhar o processo de integração de cada cliente com um TMS: cadastro, atividades, próximas ações, status e histórico completo de alterações.

## Permissões (validadas no backend em cada rota)
`integrations.view` (consultar) · `.create` · `.edit` · `.log` (adicionar atividade) · `.status` (Início ↔ Acompanhamento) · `.finish` · `.reopen` · `.history` (histórico de alterações) · `.archive` (arquivar/restaurar) · `.admin` (tipos de atividade; corrigir/remover atividades). Perfis: **Administrador** (todas) e **Integração de clientes** (view, create, edit, log, status, finish, history). Externos recebem 403 em todas as rotas.

## Modelo de dados (migração `004`)
- `customer_integrations`: empresa (`companies`), TMS (`systems`), objetivo, descrição, CS/GC e responsável operacional (`users` internos), status (`inicio|acompanhamento|finalizado`), datas, próxima ação (descrição, responsável, data, observações), dados de finalização, arquivamento, `version` (controle otimista) e `create_token` (idempotência).
- `integration_activities`: histórico do acompanhamento (tipo, descrição, resultado, próxima ação; autor e data/hora definidos pelo servidor). Remoção é lógica e só por administradores.
- `integration_activity_types`: tipos configuráveis (11 iniciais; novos via `POST /api/integrations/activity-types`).
- `integration_changes`: histórico de alterações **imutável** (trigger bloqueia UPDATE/DELETE): usuário (id e nome), operação (`operation_id` agrupa os campos salvos juntos), campo, valor anterior/novo, tipo e data/hora do banco.

## Regras
- **Auditoria transacional**: a alteração do card, as linhas de `integration_changes` e o `audit_logs` são gravados na mesma transação; falha em qualquer parte reverte tudo (testado).
- **Só o que mudou**: o servidor compara com o valor persistido; sem diferença não há registro nem incremento de versão. Campos de referência (empresa, TMS, usuários) são registrados pelo **nome**.
- **Concorrência**: `PUT`/ações exigem `version`; se mudou, resposta 409 `VERSION_CONFLICT` com os dados atuais e a tela oferece "Recarregar dados atuais" (nada é sobrescrito).
- **Status**: novo card = Início. Início↔Acompanhamento via Alterar; **Finalizar** (confirmação + resumo do resultado) e **Reabrir** (motivo obrigatório) são ações próprias. A finalização anterior (data, resultado) fica no histórico ao reabrir. Nada é apagado.
- **Duplicidade**: o formulário envia um `requestId`; reenvio devolve o card já criado.
- **Indicadores** são calculados no banco (cards não arquivados); "ação vencida" exige data prevista e card não finalizado (fuso `APP_TIMEZONE`).
- Textos são armazenados como texto simples (parágrafos e listas com "- ") e exibidos escapados, sem HTML.
- Empresa/TMS novos podem ser cadastrados no formulário por quem já tem `users.manage` / `categories.manage`.

## Limitações
- CS e GC não são papéis distintos no sistema atual: o campo "CS/GC" aceita qualquer usuário interno ativo.
- Sem notificações automáticas nem integrações externas para próximas ações (fora do escopo).
