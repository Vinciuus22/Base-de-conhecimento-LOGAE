# Variáveis de ambiente e dependências externas

O backend lê `server/.env` (modelo em `.env.example` na raiz) e valida tudo na
inicialização (`server/src/config.ts`); valores inválidos impedem a partida.

## Essenciais

| Variável | Padrão | Descrição |
|---|---|---|
| `DATABASE_URL` | — (obrigatória) | Conexão PostgreSQL 16+ |
| `DATABASE_SSL` | `false` | TLS com verificação de certificado |
| `APP_SECRET` | valor de desenvolvimento | **Obrigatório em produção** (≥ 32 caracteres) |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Porta e interface |
| `PUBLIC_BASE_URL` | `http://localhost:5173` | Origem pública (verificação de `Origin`) |
| `APP_NAME` | Base de Conhecimento LOGAE | Nome exibido |
| `APP_TIMEZONE` | `America/Sao_Paulo` | Fuso usado na apresentação das datas (armazenamento sempre em UTC) |
| `NODE_ENV` | `development` | `production` ativa validações adicionais |

## Sessão e acesso

| Variável | Padrão | Descrição |
|---|---|---|
| `SESSION_TTL_HOURS` | `12` | Validade da sessão (deslizante) |
| `COOKIE_SECURE` | `false` | `true` em produção (HTTPS) |
| `TRUST_PROXY` | `false` | `true` atrás de proxy reverso |
| `PUBLIC_ANONYMOUS_ACCESS` | `true` | Visitantes leem artigos externos e usam o chat |
| `RATE_LIMIT_LOGIN_PER_MIN` | `10` | Tentativas de login por IP |
| `RATE_LIMIT_CHAT_PER_MIN` | `20` | Perguntas ao chat/auxílio da IA |
| `RATE_LIMIT_TICKETS_PER_HOUR` | `20` | Aberturas de ticket |

## Bloqueio de edição

| Variável | Padrão | Descrição |
|---|---|---|
| `LOCK_TTL_SECONDS` | `120` | Validade do lease sem renovação |
| `LOCK_HEARTBEAT_SECONDS` | `30` | Intervalo de renovação pelo editor |

## Arquivos

| Variável | Padrão | Descrição |
|---|---|---|
| `STORAGE_DRIVER` | `local` | `local` ou `s3` |
| `STORAGE_LOCAL_DIR` | `./storage` | Diretório privado (não exponha via servidor web) |
| `S3_BUCKET`, `S3_REGION` | — | Obrigatórias com `s3` |
| `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE` | — | Para MinIO/R2/compatíveis |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | — | Credenciais (ou papel IAM do ambiente) |
| `SIGNED_URL_TTL_SECONDS` | `300` | Validade das URLs temporárias |
| `MAX_IMAGE_MB` / `MAX_VIDEO_MB` / `MAX_ATTACHMENT_MB` / `MAX_DOCUMENT_MB` | 10 / 200 / 25 / 30 | Limites por tipo |
| `FFMPEG_PATH` | `ffmpeg` | Miniaturas de vídeo (sem ffmpeg, o usuário envia a capa) |
| `DOC_CONVERSION_ENABLED` | `false` | Habilita importação de `.doc` |
| `SOFFICE_PATH` | `soffice` | LibreOffice para converter `.doc` |

## Tickets

| Variável | Padrão | Descrição |
|---|---|---|
| `TICKET_REOPEN_WINDOW_DAYS` | `7` | Prazo para o cliente reabrir ticket resolvido/fechado |

## Inteligência artificial

| Variável | Padrão | Descrição |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | **Credencial necessária** para respostas geradas e auxílio na descrição. Sem ela: modo de consulta |
| `AI_MODEL` | `claude-opus-5-5` | Modelo Claude |
| `AI_EFFORT` | `low` | Esforço de raciocínio (`low`…`max`); `low` privilegia latência e custo |
| `AI_SERVER_FALLBACKS` | `true` | Fallback automático do servidor em caso de recusa (`fallbacks: "default"`) |
| `AI_MAX_SOURCES` | `6` | Trechos enviados por pergunta |
| `AI_TIMEOUT_MS` | `60000` | Tempo limite por chamada |
| `AI_CONVERSATION_RETENTION_DAYS` | `180` | Retenção das conversas |
| `VOYAGE_API_KEY` | — | **Credencial opcional** para pesquisa semântica (embeddings) |
| `EMBEDDINGS_MODEL` | `voyage-3.5` | Modelo de embeddings |

## Outras

| Variável | Padrão | Descrição |
|---|---|---|
| `LOG_LEVEL` | `info` | Nível de log (pino) |
| `SERVE_WEB` / `WEB_DIST_DIR` | `true` / `../web/dist` | Servir a interface compilada pelo backend |
| `MIGRATE_ON_START` | `true` | Aplicar migrations ao iniciar |

## Dependências externas

| Serviço | Obrigatório? | Credencial | Sem o serviço |
|---|---|---|---|
| PostgreSQL 16 com `unaccent` e `pg_trgm` | Sim | Usuário/senha do banco | A aplicação não inicia |
| Anthropic (Claude) | Não | `ANTHROPIC_API_KEY` | Chat em modo de consulta; auxílio da descrição indisponível (botão oculto) |
| Voyage AI | Não | `VOYAGE_API_KEY` | Somente pesquisa textual |
| S3 compatível | Não | Chaves ou papel IAM | Armazenamento em disco local |
| YouTube (navegador do usuário) | Não | — | Miniaturas/players do YouTube não carregam (redes que bloqueiam o domínio) |
| ffmpeg | Recomendado | — | Miniatura de vídeo deve ser enviada manualmente |
| LibreOffice | Não | — | `.doc` não é aceito (orienta salvar como `.docx`/PDF) |

## Contas de teste e integração com o Jira

| Variável | Padrão | Descrição |
|---|---|---|
| `TEST_LOGINS_ENABLED` | `false` | Mostra na tela de login as contas de teste (`interno@teste.com` e `externo@teste.com`, senha `Teste@12345`). **Não habilite em produção.** |
| `SEED_TEST_USERS` | `false` | No `npm run seed`, cria essas duas contas (o interno recebe o perfil de administrador; o externo pertence à "Empresa de Teste"). |
| `JIRA_WEBHOOK_SECRET` | — | Segredo do webhook `POST /api/integrations/jira/webhook` (cabeçalho `X-Jira-Secret` ou `?secret=`). |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | — | Acesso à API do Jira para a sincronização manual/periódica. |
| `JIRA_PROJECT_KEYS` | — | Projetos considerados (lista separada por vírgulas); vazio = todos. |
| `JIRA_RELEASE_FIELD` | `fixVersions` | Campo de release (nome ou `customfield_XXXXX`). Tarefa concluída **com release preenchida** vira atualização. |
| `JIRA_AUDIENCE_FIELD` | `Público alvo` | Define quem vê a atualização: externo/cliente/ambos/todos → clientes e internos; interno, vazio ou desconhecido → somente internos. |
| `JIRA_DONE_STATUSES` | Done,Concluído,… | Nomes de status tratados como concluídos (além da categoria "Done" do Jira). |
| `JIRA_SYNC_MINUTES` | `0` | Intervalo da sincronização automática (0 desativa). |
