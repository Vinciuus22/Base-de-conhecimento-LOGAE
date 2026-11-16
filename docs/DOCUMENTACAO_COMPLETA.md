# Base de Conhecimento LOGAE — Documentação completa do sistema

Documento único com a descrição de **todo o site**: finalidade, perfis, telas, funcionalidades, regras de negócio, permissões, API, modelo de dados, integrações, segurança, configuração, implantação e testes.

> Estado de referência: branch `claude/focused-babbage-jslaxx`. Este arquivo descreve o que está implementado no código. Itens ainda pendentes ou não validados estão na seção 20.

---

## Sumário

1. [Visão geral](#1-visão-geral)
2. [Tecnologias e arquitetura](#2-tecnologias-e-arquitetura)
3. [Perfis de usuário e acesso](#3-perfis-de-usuário-e-acesso)
4. [Mapa de telas](#4-mapa-de-telas)
5. [Autenticação e sessão](#5-autenticação-e-sessão)
6. [Página inicial e pesquisa](#6-página-inicial-e-pesquisa)
7. [Artigos](#7-artigos)
8. [Editor de artigos (conteúdo rico e mídia)](#8-editor-de-artigos-conteúdo-rico-e-mídia)
9. [Bloqueio de edição (um editor por vez)](#9-bloqueio-de-edição-um-editor-por-vez)
10. [Categorias, sistemas, tags e sinônimos](#10-categorias-sistemas-tags-e-sinônimos)
11. [Assistente de IA (chat)](#11-assistente-de-ia-chat)
12. [Tickets e suporte](#12-tickets-e-suporte)
13. [Documentos](#13-documentos)
14. [Comunicados](#14-comunicados)
15. [Atualizações (releases vindas do Jira)](#15-atualizações-releases-vindas-do-jira)
16. [Atualizações dos Cards (Jira, somente leitura)](#16-atualizações-dos-cards-jira-somente-leitura)
17. [Integração de Clientes](#17-integração-de-clientes)
18. [Administração: usuários, empresas, auditoria e bloqueios](#18-administração-usuários-empresas-auditoria-e-bloqueios)
19. [Segurança, privacidade (LGPD) e regras transversais](#19-segurança-privacidade-lgpd-e-regras-transversais)
20. [Pendências, limitações e decisões](#20-pendências-limitações-e-decisões)
21. [Referência técnica](#21-referência-técnica)
    - 21.1 Permissões e perfis · 21.2 Vocabulário · 21.3 API · 21.4 Modelo de dados · 21.5 Variáveis de ambiente · 21.6 Implantação · 21.7 Testes · 21.8 Contas de teste · 21.9 Design (tema Logaz) · 21.10 Mapa do repositório

---

## 1. Visão geral

Portal de **Base de Conhecimento e suporte técnico** com dois ambientes no mesmo produto:

- **Ambiente externo (clientes):** pesquisa artigos publicados como externos, conversa com o assistente de IA, lê atualizações de release e comunicados externos, abre e acompanha os próprios tickets.
- **Ambiente interno (colaboradores):** tudo do externo, mais gestão de artigos, categorias e sistemas, comunicados, atualizações do Jira, cards do Jira, documentos, integrações de clientes, fila de tickets, usuários/permissões, empresas, bloqueios de edição e auditoria.

Princípios:

- **Toda autorização é feita no backend**; a interface apenas esconde o que o usuário não pode usar.
- **Login obrigatório por padrão**: sem sessão, só a tela de entrada é acessível (`PUBLIC_ANONYMOUS_ACCESS=false`).
- **Rastreabilidade**: operações relevantes geram registros imutáveis (auditoria, histórico de artigos, tickets e integrações).
- **IA fundamentada**: o assistente só responde com base em conteúdo autorizado para o usuário e cita as fontes.
- Idioma da interface e dos dados: **português do Brasil**; fuso padrão `America/Sao_Paulo`; datas gravadas em UTC.

---

## 2. Tecnologias e arquitetura

| Camada | Tecnologia |
|---|---|
| Backend | **TypeScript**, Node.js 22, **Fastify 5**, Zod (validação), driver `pg` (SQL escrito à mão, sem ORM), Vitest |
| Frontend | React 19, TypeScript, Vite 6, React Router 7, TanStack Query, TipTap 3 (editor), lucide-react (ícones), Playwright (ponta a ponta) |
| Compartilhado | Pasta `shared/` (TypeScript): permissões, perfis, enumerações e regras de upload usadas pelo front e pelo back |
| Banco | PostgreSQL 16 com extensões `pgcrypto`, `unaccent`, `pg_trgm`; configuração de pesquisa `pt_unaccent` |
| Arquivos | Disco local privado ou S3 compatível (URLs pré-assinadas de curta duração) |
| IA | Claude (Anthropic) para respostas; Voyage AI opcional para pesquisa semântica |
| Mídia/documentos | sharp (imagens), ffmpeg (miniaturas de vídeo), unpdf (PDF), mammoth (DOCX), LibreOffice opcional (.doc) |
| Monorepo | npm workspaces: `shared/`, `server/`, `web/` |

Arquitetura resumida:

```
Navegador (React + TipTap)
   │  HTTPS · cookie de sessão httpOnly + token CSRF
   ▼
API Fastify (Node) ── PostgreSQL 16
   │       ├── Armazenamento privado (disco ou S3)
   │       ├── Claude API (somente trechos autorizados)
   │       ├── Voyage AI (opcional)
   │       └── Jira (webhooks + API de leitura)
   └── serve o frontend compilado (SERVE_WEB=true)
```

Tarefas periódicas do servidor (`server/src/jobs.ts`): liberar bloqueios de edição expirados (a cada 30 s), limpar sessões expiradas e processar embeddings pendentes (a cada 10 min), apagar conversas de IA antigas (a cada 6 h), retomar documentos pendentes e, opcionalmente, sincronizar o Jira (atualizações e cards).

---

## 3. Perfis de usuário e acesso

| Tipo | Quem é | O que vê |
|---|---|---|
| **Visitante** | Sem sessão | Nada, a menos que `PUBLIC_ANONYMOUS_ACCESS=true` (então lê conteúdo externo e usa o chat) |
| **Externo (cliente)** | Usuário com `user_type=external`, vinculado a uma empresa | Artigos externos, atualizações externas, comunicados externos, chat, os próprios tickets (e os da empresa com `tickets.view_company`) |
| **Interno** | Colaborador (`user_type=internal`) | Conteúdo interno e externo conforme as permissões; ambiente interno |

Regras gerais:

- Usuário interno **sem perfil/permissão** não acessa nenhuma área do ambiente interno além do conteúdo permitido.
- O botão **Ambiente interno** só aparece para usuários internos; as rotas `/interno/*` exigem usuário interno e a permissão da tela.
- Recursos sem acesso retornam **404** (não revelam existência); operações sem permissão retornam **403**; sem sessão, **401**.
- Permissões efetivas = (perfis ∪ concessões individuais) − revogações individuais, filtradas pelo tipo do usuário. Permissões "somente internas" nunca valem para externos. Detalhes na seção 21.1.

---

## 4. Mapa de telas

### Públicas / compartilhadas (com sessão)

| Rota | Tela | Quem acessa |
|---|---|---|
| `/entrar` | Login (sem cabeçalho nem assistente) | Todos |
| `/` | Início: busca, chips de sistema, categorias, listas de artigos, resultados da pesquisa | Logados (ou visitantes se o acesso anônimo estiver ligado) |
| `/busca` | Redireciona para `/` | — |
| `/artigos/:slug` | Leitura de artigo | Conforme visibilidade/status |
| `/atualizacoes`, `/atualizacoes/:id` | Atualizações de release (somente leitura) | Todos; externos veem só as externas |
| `/comunicados`, `/comunicados/:id` | Comunicados publicados | Externos: só os "Externo"; internos: externo + interno |
| `/documentos/:id` | Visualização de documento importado aprovado | Conforme visibilidade |
| `/tickets` | Meus tickets | Logados |
| `/tickets/novo` | Abrir ticket | Logados |
| `/tickets/:id` | Detalhe do ticket (visão do cliente) | Solicitante / mesma empresa (com permissão) |
| `/conta` | Minha conta e troca de senha | Logados |

### Ambiente interno (`/interno`, dentro do layout com menu lateral)

| Rota | Tela | Permissão exigida |
|---|---|---|
| `/interno` | Painel | Interno |
| `/interno/artigos` | Artigos agrupados por categoria | Interno (com acesso a artigos) |
| `/interno/artigos/:id/historico` | Histórico e versões do artigo | `articles.history` |
| `/interno/artigos/novo` | Editor — novo artigo (tela cheia) | `articles.create` |
| `/interno/artigos/:id/editar` | Editor — editar (tela cheia) | `articles.edit` ou `articles.edit_others` |
| `/interno/categorias` | Categorias, sistemas, tags e sinônimos | `categories.manage` |
| `/interno/comunicados`, `/novo`, `/:id` | Gestão e editor de comunicados | `announcements.manage` |
| `/interno/atualizacoes` | Gestão das atualizações vindas do Jira | `updates.manage` |
| `/interno/cards`, `/interno/cards/:key` | Atualizações dos Cards (lista e histórico) | `cards.view` |
| `/interno/integracoes`, `/nova`, `/:id` | Integração de Clientes | `integrations.view` / `.create` |
| `/interno/documentos`, `/:id` | Documentos (material de apoio + importados para IA) | `documents.manage` |
| `/interno/tickets`, `/interno/tickets/:id` | Fila e atendimento de tickets | `tickets.support` ou `tickets.manage` |
| `/interno/usuarios`, `/:id` | Usuários e permissões | `users.manage` |
| `/interno/empresas` | Empresas, acesso multi-empresa e sistemas contratados | `users.manage` |
| `/interno/bloqueios` | Bloqueios de edição | `locks.release` |
| `/interno/auditoria` | Auditoria | `audit.view` |

### Estrutura comum

- **Cabeçalho** verde (`#064B3A`, borda inferior menta `#19B987`): logo; navegação **Início · Atualizações · Comunicados · Meus tickets · Ambiente interno** (este último só para internos); nome do usuário (link para Minha conta) e **Sair**. Em telas estreitas a navegação vira menu recolhível.
- **Menu lateral do ambiente interno** (cartão), só com o que o usuário pode acessar:
  - *Visão geral:* Painel.
  - *Conteúdo:* Artigos · Categorias e sistemas · Comunicados · Atualizações dos Cards · Documentos.
  - *Atendimento:* Integração de Clientes · Tickets · Meus tickets.
  - *Administração:* Usuários e permissões · Empresas · Bloqueios de edição · Auditoria.
- **Assistente virtual**: botão flutuante no canto inferior direito em todas as telas (exceto login), visível só com sessão (ou acesso anônimo ligado).
- **Rodapé**: copyright e link para abrir ticket.
- Rotas inexistentes: "Página não encontrada". Rotas internas sem permissão: "Acesso não autorizado".

---

## 5. Autenticação e sessão

- **Login** por e-mail e senha (`POST /api/auth/login`). Tela: título "Entrar na sua conta", campos **Login** e **Senha** (com botão para exibir/ocultar), link "Esqueceu sua senha?" (orienta procurar o administrador — não há redefinição por e-mail), botão **Entrar**.
- **Login primeiro**: sem sessão (e com `PUBLIC_ANONYMOUS_ACCESS=false`), qualquer endereço redireciona para `/entrar?voltar=<endereço>`; após entrar, volta ao endereço original.
- **Contas de teste** (somente se `TEST_LOGINS_ENABLED=true`): caixa na tela de login com botões que preenchem os campos. Ver seção 21.8.
- **Senhas**: scrypt; política mínima de 10 caracteres com letras e números. **5 falhas seguidas bloqueiam a conta por 15 minutos**; o tempo de resposta é equalizado para e-mails inexistentes (não revela se o e-mail existe).
- **Sessão**: token aleatório de 256 bits em cookie `httpOnly`, `SameSite=Lax` (`Secure` em produção), guardado como hash SHA-256; expiração deslizante (padrão 12 h, `SESSION_TTL_HOURS`). Sessões encerram ao trocar a senha, desativar o usuário ou sair.
- **CSRF**: token por sessão no cabeçalho `X-CSRF-Token` em toda requisição que altera estado, mais verificação do cabeçalho `Origin`.
- **Minha conta** (`/conta`): dados (nome, e-mail, empresa, perfil) e **alterar senha** (senha atual, nova com mínimo de 10 caracteres, confirmação; ao concluir as demais sessões são encerradas).
- **Limite de tentativas** de login: `RATE_LIMIT_LOGIN_PER_MIN` (padrão 10/min).

---

## 6. Página inicial e pesquisa

**Hero** verde com o título "Como podemos ajudar?", campo de busca ("Pesquise por título, palavra-chave, categoria ou sistema"), botão **Limpar** e **chips de sistema** (um por sistema cadastrado; clicar filtra, clicar de novo remove).

- A **pesquisa acontece na própria Início** (não há tela de busca separada). O resultado é atualizado enquanto o usuário digita (com atraso de ~300 ms); os termos ficam na URL (`?q=`, `system`, `category`, `tag`, `visibility`, `from`, `to`).
- **Sem busca**: seção **Artigos por categoria** (cartões com nome, descrição e contagem de artigos; clicar filtra por categoria) e duas listas:
  - *Interno:* **Mais acessados** (toda a base) e **Atualizados recentemente**.
  - *Externo:* **Mais acessados por todos os clientes** e **Mais acessados por você** (histórico de leitura do próprio usuário; visitantes veem "Atualizados recentemente").
- **Com busca**: lista de resultados com título (termos destacados), categoria, sistema, selo de visibilidade (para internos), data de atualização, resumo e trecho; filtros laterais (categoria, sistema, tag, visibilidade para internos, período). Sem resultados: orientação e botões **Perguntar ao assistente** e **Abrir ticket**.

**Regras da pesquisa** (`server/src/modules/articles/search.ts`):

- Texto completo em português **sem acentos** (`pt_unaccent`), insensível a maiúsculas.
- Pesos: título (A) › palavras-chave, tags e resumo (B) › categoria e sistema (C) › conteúdo (D).
- Consulta "OU" com **prefixos** (exportar/exportação), **sinônimos** cadastrados, bônus quando todos os termos aparecem e **similaridade de trigramas** para erros de digitação.
- **"Você quis dizer"** calculado só sobre artigos visíveis ao usuário.
- Complemento **semântico** (embeddings) quando `VOYAGE_API_KEY` está configurada.
- Só retorna artigos **publicados** e permitidos ao usuário (externos: apenas externos).

---

## 7. Artigos

**Campos:** título, resumo, conteúdo (rico), categoria, sistema, palavras-chave, tags, visibilidade (Interno/Externo), status, versão, autor, datas.

**Status:** Rascunho → Publicado ⇄ Despublicado → Arquivado (e restauração do arquivo).

**Regras de publicação** (validadas no backend; há `CHECK` no banco):

- Artigo publicado exige **categoria, sistema, resumo, conteúdo, data e responsável pela publicação**.
- Publicar, despublicar e arquivar exigem permissões próprias (`articles.publish`, `.unpublish`, `.archive`).
- **Alterar um artigo já publicado exige `articles.publish`** (as alterações entram no ar imediatamente).
- Alterar a visibilidade é registrada como operação própria no histórico.
- A visibilidade é **obrigatória** (Interno ou Externo).

**Acesso:**

- Publicado externo → qualquer usuário permitido. Publicado interno → internos com `articles.view_internal`.
- Rascunho/despublicado/arquivado → somente internos: o autor (com criar/editar) ou quem tem editar de outros/publicar/despublicar/arquivar.
- Cada leitura de artigo publicado incrementa o contador de visualizações e, para usuário logado, o seu histórico de leitura (alimenta "Mais acessados por você").
- A API nunca guarda artigos em cache (`no-store`).

**Leitura (`/artigos/:slug`)**: trilha de navegação, título, resumo, metadados (categoria, sistema, data, tags), conteúdo com os blocos de destaque e mídias, sumário "Nesta página", artigos relacionados (mesma categoria, sistema ou tags), rodapé com **Perguntar ao assistente** e **Abrir ticket**. Internos autorizados veem uma barra "Gestão do artigo" (status, visibilidade, versão, Editar, Histórico, Publicar/Despublicar, Arquivar).

**Lista interna (`/interno/artigos`)**: todos os artigos agrupados **por categoria** (cabeçalho com contagem); filtros por título, status, visibilidade, sistema e "Somente meus artigos"; colunas Título, Status, Visibilidade, Sistema, Autor, Versão, Atualização e **Edição** ("Disponível" ou o nome de quem está editando).

**Histórico e versões (`/interno/artigos/:id/historico`)**, com `articles.history`:

- Cada salvamento gera uma **versão imutável** (snapshot completo) e um registro de histórico imutável (operação, usuário, data/hora, resumo e alterações campo a campo).
- Operações registradas: criação, edição, publicação, despublicação, alteração de visibilidade, arquivamento, restauração do arquivo, restauração de versão e **salvamento rejeitado**.
- Comparação entre versões (diferenças destacadas) e **restauração de uma versão antiga** (gera uma nova versão).

---

## 8. Editor de artigos (conteúdo rico e mídia)

Editor TipTap em tela cheia, também usado nos comunicados.

**Formatação:** parágrafo/títulos, fonte, tamanho, negrito, itálico, sublinhado, tachado, código, cor do texto, realce, alinhamento (esquerda/centro/direita/justificado), listas com marcadores e numeradas, citação, bloco de código, linha divisória, link, tabela.

**Blocos de destaque (callouts)** — 5 tipos: **Atenção, Alerta, Importante, Dica, Informação**. Inseridos pelo botão "Destaque" sem que o usuário escreva código; têm cor e ícone próprios na leitura.

**Imagens e GIFs:** upload de PNG, JPEG, WebP e GIF (limite padrão 10 MB); tipo real verificado pela assinatura do arquivo; SVG é rejeitado.

**Vídeos:**

- **YouTube**: cola-se o link; o conteúdo guarda só o identificador do vídeo e usa `youtube-nocookie.com`.
- **Upload** de MP4, WebM e MOV (limite padrão 200 MB), com **miniatura** gerada pelo ffmpeg no primeiro segundo (ou enviada manualmente se o ffmpeg não existir).
- Na leitura o vídeo aparece como **miniatura com botão de reproduzir**; ao clicar abre um **player ampliado em modal** (proporção 16:9) que fecha com Esc ou no botão e devolve o foco ao botão.

**Anexos** no conteúdo conforme a lista de tipos permitidos (PDF, Word, Excel, ZIP, texto, CSV) até 25 MB.

**Pré-visualização:** o botão **Visualizar artigo** abre o conteúdo com o mesmo renderizador do artigo publicado.

**Outros comportamentos:** campos laterais de classificação (visibilidade, categoria, sistema, palavras-chave, tags), cadastro rápido de categoria; **Salvar rascunho** e **Salvar e concluir edição**; alerta ao sair com alterações não salvas; **auxílio de IA para descrição/resumo** (quando há chave do Claude).

**Segurança do conteúdo:** o HTML é **sanitizado no servidor** com lista de permissões (tags, atributos, estilos e esquemas de URL); imagens só podem apontar para `/api/files/...`; vídeos são guardados apenas pelo ID; o navegador reinterpreta o conteúdo pelo esquema do editor.

---

## 9. Bloqueio de edição (um editor por vez)

Garante que **só uma pessoa edita um artigo por vez**, de forma atômica no banco.

- **Adquirir:** `POST /api/articles/:id/lock` executa um único `INSERT … ON CONFLICT … WHERE expires_at <= now()`; `article_id` é chave primária, então só existe um bloqueio por artigo. Testado com 8 aquisições simultâneas.
- **Lease com renovação:** o detentor recebe um token secreto e renova (`heartbeat`) a cada `LOCK_HEARTBEAT_SECONDS` (30 s); validade `LOCK_TTL_SECONDS` (120 s). Cada renovação revalida a permissão de edição.
- **Para os demais:** o botão "Editar artigo" fica desabilitado e a tela mostra *"Este artigo está sendo editado por {nome} desde {data} às {hora}…"* com dados reais; a situação é consultada a cada ~8 s.
- **Liberação:** ao salvar e concluir, cancelar, sair da tela, fechar a aba (`sendBeacon`), logout, desativação do usuário, ou expiração do lease (registrada na auditoria).
- **Salvamento seguro:** na mesma transação o servidor trava o bloqueio (`FOR UPDATE`), confere token, usuário e validade, revalida a autorização e aplica **controle de concorrência otimista** (`expectedVersion`). Qualquer divergência retorna `409` e grava um registro `save_rejected`.
- **Liberação administrativa** (`locks.release`, tela **Bloqueios de edição**): exige motivo e registra administrador, detentor, artigo, data/hora e motivo; a sessão antiga perde o token e não consegue salvar.

---

## 10. Categorias, sistemas, tags e sinônimos

Tela `/interno/categorias` (`categories.manage`), em abas:

- **Categorias**: nome, descrição, ordem; excluir é bloqueado se há artigos vinculados (restrição de integridade).
- **Sistemas** (ex.: eCentral, eTorre, ePonto, PEC, Siga Verde, Checklist — **a lista é editável**, não é fixa no código): nome e descrição. Os sistemas são usados em artigos, tickets, comunicados, atualizações, documentos, empresas (contratados) e como **TMS** nas integrações.
- **Tags**.
- **Sinônimos da pesquisa**: termo → termos alternativos, usados para ampliar a busca (único por termo sem acento).

---

## 11. Assistente de IA (chat)

**Interface:** botão flutuante "Assistente" (ícone de faísca); painel branco de 360 × 500 px com cabeçalho ("Assistente virtual" e subtítulo "Artigos internos e externos" para internos / "Base de Conhecimento pública" para externos), botões **Nova conversa** e **Fechar** (Esc também fecha), mensagens, indicador de digitação e campo de pergunta (Enter envia, Shift+Enter quebra linha; mínimo 2 caracteres; máximo 2.000). A conversa fica no navegador (`sessionStorage`) e reinicia ao entrar/sair. Abre também pelo botão "Perguntar ao assistente" dos artigos e da pesquisa.

**Como responde** (`server/src/modules/ai`):

1. O backend define o público (interno/externo) pelas permissões do usuário.
2. Recupera trechos com **filtro duplo**: metadados do trecho **e** estado atual da fonte (artigo publicado / documento aprovado e não removido) com visibilidade permitida. Externos jamais recebem fontes internas.
3. **Sem trechos relevantes** → mensagem padrão *"Não encontrei na Base de Conhecimento uma solução confirmada para essa situação…"* e oferta de ticket, **sem chamar o modelo**.
4. **Com trechos** → o Claude recebe só esses trechos (tratados como dados, não instruções) e responde em JSON estruturado (`found_solution`, `answer`, `steps`, `source_ids`).
5. O servidor aceita **apenas IDs de fontes realmente enviados**, monta os links das fontes e **remove URLs do texto gerado**.
6. A resposta exibe texto, passos numerados, pergunta de acompanhamento e **"Fontes consultadas"** (título e trecho citado, com link).
7. Se não resolveu, aparece **"Deseja que a equipe de suporte analise?"** com botão **Abrir ticket** (leva ao formulário com rascunho preenchido).
8. **Sem `ANTHROPIC_API_KEY`**, o chat funciona em **modo de consulta** (mostra os trechos encontrados) e avisa isso na interface.

**Limites e privacidade:** `RATE_LIMIT_CHAT_PER_MIN` (20/min); conversas apagadas após `AI_CONVERSATION_RETENTION_DAYS` (180); só o texto digitado e os trechos da base vão ao provedor; dados de tickets **não** são enviados ao chat. Modelo padrão `claude-opus-5-5`, esforço `low`, com fallback do servidor habilitado.

**Auxílio de IA no editor:** gera sugestão de descrição/resumo a partir do conteúdo (botão oculto quando a IA não está configurada).

---

## 12. Tickets e suporte

### Cliente (`/tickets`, `/tickets/novo`, `/tickets/:id`)

- **Meus tickets**: indicadores (**Em aberto, Aguardando você, Em atendimento, Finalizados**), tabela **Pendentes e em aberto** (Protocolo, Título, Sistema, Abertura, Atualização, Status, Prioridade) e seção **Finalizados** com busca própria. Usuários com `tickets.view_company` podem alternar para os tickets da empresa (inclui empresas extras com acesso concedido).
- **Abrir ticket** — campos: título, descrição, tipo (Incidente/erro, Dúvida, Solicitação, Sugestão de melhoria), categoria, prioridade, **sistema** (obrigatório), empresa (preenchida pelo cadastro; internos sem empresa escolhem) e **anexos**.
  - **Anexo obrigatório: pelo menos uma imagem ou vídeo** (senão: "Anexe pelo menos uma imagem ou vídeo para abrir o ticket").
  - Aceita rascunho vindo do assistente/pesquisa/artigo.
  - Gera **protocolo** único (ano + sequência, ex.: `2026000009`).
  - Limite: `RATE_LIMIT_TICKETS_PER_HOUR` (20/h).
- **Detalhe do ticket**: linha do tempo com mensagens públicas (imutáveis), solução aplicada, anexos, movimentações. O cliente pode **responder** (com anexos), **confirmar a resolução** (só se *Resolvido*) e **reabrir** (se *Resolvido* ou *Fechado*, dentro de `TICKET_REOPEN_WINDOW_DAYS` = 7 dias).

### Equipe de suporte (`/interno/tickets`, `/interno/tickets/:id`)

- **Escopo:** quem tem `tickets.support` vê tickets **sem responsável ou atribuídos a si**; `tickets.manage` vê **todos** e pode atribuir.
- **Fila** em três seções, nesta ordem: **Pendentes** (aguardando usuário, aguardando equipe técnica, em triagem) → **Em aberto** (aberto, em atendimento) → **Finalizados** (resolvido, fechado); indicadores (Pendentes, Em aberto, Sem responsável, Finalizados) e filtros (protocolo/título/solicitante, sistema, responsável incl. "Sem responsável", prioridade).
- **Ações no ticket:** responder ao cliente, **solicitar informações**, registrar **solução aplicada** (`/resolution`), **observações internas** (nunca visíveis ao cliente, com anexos próprios), alterar **status** (transições permitidas — ver 21.2), **atribuir** responsável, alterar **classificação** (categoria/prioridade/sistema), **vincular artigos** da base ao ticket, **sugerir artigo** (gera rascunho **interno** a partir do ticket, com aviso para remover dados de clientes).
- **Auditoria:** acessos negados e ações relevantes ficam registrados (`ticket.access_denied`, etc.).
- Mensagens, observações e movimentações são **imutáveis** (triggers no banco).

---

## 13. Documentos

Tela `/interno/documentos` (`documents.manage`) com **duas abas**:

### 13.1 Material de apoio (padrão)

Repositório de documentos do suporte (requisições, documentação de API, manuais, planilhas).

- **Incluir documento**: Título*, Tipo* (Requisição, Documentação de API, PDF/Manual, Planilha, Outro), Sistema*, Visibilidade* (Interno/Externo), Descrição, **arquivo** (`.pdf .doc .docx .xls .xlsx .json .yaml .yml .txt .csv`) **ou** **link externo** (http/https). É obrigatório anexar arquivo **ou** informar link ("Anexe um arquivo ou informe um link externo.").
- Validação do arquivo pela assinatura real; tamanho máximo `MAX_DOCUMENT_MB` (30). Arquivos seguem a visibilidade do documento (interno: só equipe; externo: conforme acesso anônimo/logado).
- **Lista** com selo por tipo (REQ, API, PDF, XLS, DOC), título, selos de visibilidade e sistema, descrição, meta (tipo · autor · data · arquivo) e ações **Abrir** e **Excluir** (exclusão lógica, auditada). Filtros: pesquisa, tipo, sistema (pesquisa sem acento).

### 13.2 Importados para pesquisa e IA

Fluxo de importação de PDF/DOCX (`.doc` só com LibreOffice habilitado):

1. **Upload** com metadados (título, categoria, sistema, palavras-chave, visibilidade); valida assinatura real, tamanho e **duplicidade por SHA-256**.
2. **Processamento** em fila: extração de texto, páginas, avisos; status: *Aguardando processamento → Em processamento → Processado / Processado com avisos / Falha*; com tentativas e reprocessamento.
3. **Revisão obrigatória**: *Aguardando revisão → Aprovado / Rejeitado*. **Somente documentos aprovados** entram na pesquisa e na IA. Tornar externo um documento aprovado, ou reprocessá-lo, exige nova revisão.
4. **Criar artigo a partir do documento** (rascunho) e vincular artigos.
5. **Remoção** lógica: apaga o arquivo e mantém o registro para rastreabilidade.
6. Documentos aprovados podem ser visualizados em `/documentos/:id` conforme a visibilidade.

---

## 14. Comunicados

Avisos vinculados a **uma ou mais plataformas (sistemas)**, com **imagens e vídeos**.

- **Leitura** (`/comunicados`): lista com filtros (pesquisa, sistema, categoria, a partir de), badge de categoria, selos de plataformas, data e resumo; detalhe com o conteúdo e artigos relacionados.
  - **Externo** publicado → visível a clientes e à equipe (e a visitantes se o acesso anônimo estiver ligado).
  - **Interno** publicado → só equipe interna.
  - **Rascunho** → só quem tem `announcements.manage`.
- **Categorias:** Novidade, Alteração de funcionalidade, Manutenção, Comunicado.
- **Gestão** (`/interno/comunicados`, `announcements.manage`; **cadastro exclusivo de usuários internos**): lista de publicados e rascunhos (status, categoria, visibilidade, autor, plataformas); formulário com **Título***, **Visibilidade*** (Interno/Externo), **Categoria***, **Plataformas vinculadas*** (múltipla escolha, mínimo 1), conteúdo com o editor rico (imagens, vídeos), artigos relacionados; ações **Salvar**, **Salvar e publicar**, **Despublicar**.
- **Pré-visualização**: botão **Visualizar comunicado** abre um painel "Pré-visualização — visão do cliente externo / do usuário interno" com categoria, plataformas, data, título, conteúdo renderizado e autor, atualizado conforme o preenchimento (com marcadores de campos vazios).
- Os arquivos do comunicado herdam o acesso do próprio comunicado.

---

## 15. Atualizações (releases vindas do Jira)

Tela **Atualizações** (`/atualizacoes`): novidades entregues nas releases. **Somente leitura para clientes.**

**Regra de entrada (integração com o Jira):** uma tarefa **concluída com o campo *release* preenchido** vira automaticamente uma atualização publicada. Concluída = categoria de status "Done" do Jira **ou** status listado em `JIRA_DONE_STATUSES`.

**Campo "Público alvo"** define quem vê:

| Valor no Jira | Visibilidade |
|---|---|
| externo, cliente, ambos, todos | **Externo** (clientes e internos) |
| interno, vazio ou desconhecido | **Interno** (padrão seguro) |

- Tarefa reaberta ou release apagada → a atualização é ocultada (a menos que haja ajuste manual).
- Ajustes manuais de quem tem `updates.manage` (ocultar/exibir, mudar público, trocar sistema) **marcam a atualização como "ajuste manual"**, preservada nas próximas sincronizações até **"Devolver ao Jira"**.
- Sistema vinculado a partir do componente do Jira quando o nome coincide.

**Entrada de dados:** webhook `POST /api/integrations/jira/webhook` (segredo no cabeçalho `X-Jira-Secret` ou `?secret=`) e/ou sincronização pela API (`POST /api/updates/sync` ou automática por `JIRA_SYNC_MINUTES`), com JQL de tarefas concluídas com release.

**Telas:**

- **Lista pública:** filtros (pesquisa, sistema, release, a partir de), cartões com título, selo **Release X**, sistema, data e descrição; **internos** veem também o selo Interno/Externo e o **link do card no Jira**; **externos** veem só release, data e descrição, apenas das atualizações externas.
- **Gestão** (`/interno/atualizacoes`, `updates.manage`): estado da integração (webhook, API, campos, projetos, sincronização), botão **Sincronizar agora**, e por atualização: Ocultar/Exibir, alternar público, Devolver ao Jira.

---

## 16. Atualizações dos Cards (Jira, somente leitura)

Painel interno `/interno/cards` (`cards.view`) que espelha localmente os cards dos projetos monitorados (padrão **CHL** e **RISK1**, configurável em `JIRA_CARD_PROJECTS`) e guarda o **histórico completo** de cada um. **Nenhuma operação escreve no Jira e nenhuma notificação é enviada ao responsável.**

**Listagem:** colunas Chave, Título, Projeto/quadro, Status (cor derivada do nome; status novos do Jira aparecem sozinhos), Responsável, Última alteração, Autor da alteração, Tipo de alteração, Ações (Histórico | Jira). Ordenada pela alteração mais recente, 20 por página, filtros e página preservados na URL. Pesquisa sem acento por chave, título, descrição, responsável e autor de qualquer alteração. Filtros: projeto, **status (vários)**, responsável, autor, tipo de evento, datas, "atualizados nas últimas 24 h/7/30 dias". A tela se atualiza a cada 60 s. Faixa de estado mostra **última sincronização bem-sucedida**, falhas e dados desatualizados, e o botão **Sincronizar agora** (`cards.sync`) dispara a sincronização real.

**Detalhe:** chave, título, projeto/quadro, status, responsável, datas, prioridade, descrição, botão **Abrir no Jira**, aviso de **histórico possivelmente incompleto** quando houve falha ao recuperar changelog/comentários, e a linha do tempo **Histórico de alterações** (ordenação invertível; filtros por texto, tipo, autor, campo e período; paginação).

**Eventos do histórico:** card criado, mudança de **status** (anterior → novo), **responsável**, descrição, prioridade, campo, **comentário** (novo/editado/removido). Cada evento traz autor registrado pelo Jira (nome e accountId), data/hora e id do evento no Jira. O **autor nunca é confundido com o responsável atual**; sem autor: "Autor não disponível"; contas listadas em `JIRA_SHARED_ACCOUNTS` aparecem como **conta compartilhada** (não identifica pessoa). Comentários com restrição de visibilidade no Jira são registrados **sem o conteúdo**.

**Sincronização:**

- **Webhook** `POST /api/integrations/jira/cards/webhook` (mesmo segredo): grava o evento recebido e, se a API estiver configurada, reconcilia o histórico completo; eventos repetidos são ignorados (chave única); projetos não monitorados são ignorados.
- **Varredura** (manual ou `JIRA_CARDS_SYNC_MINUTES`): primeira execução completa, depois incremental (`updated >= -Nm` com 60 min de sobreposição); paginação de busca, changelog e comentários; **retentativas** com espera crescente em falhas temporárias (rede, 429, 5xx); 401/403/404 não são retentados; falha geral **não apaga** dados já sincronizados; execuções registradas (`success`/`partial`/`failed` e erro) sem expor credenciais; uma sincronização por vez.
- Quadro/board do card obtido pela API ágil quando disponível.

---

## 17. Integração de Clientes

Módulo `/interno/integracoes` para acompanhar o processo de integração de cada cliente com um **TMS** (sistema). Um **card** por integração.

**Status:** **Início** (criação) → **Acompanhamento** → **Finalizado**. Sempre exibidos com nome e cor (Início azul, Acompanhamento amarelo/laranja, Finalizado verde).

**Listagem:** indicadores clicáveis (Total, Em início, Em acompanhamento, Finalizadas, Próxima ação vencida); visualização em **cards** (borda na cor do status, TMS, objetivo, CS/GC, responsável, datas, bloco da próxima ação — vermelho "Próxima ação vencida" quando atrasada) ou **tabela**; pesquisa (empresa, TMS, objetivo, CS/GC, responsável) sem acento; filtros por status, empresa, TMS, CS/GC, responsável e datas (criação, previsão, atualização); ordenação por atualização (padrão), criação, empresa, status ou previsão; opção "Arquivadas" (`integrations.archive`).

**Criar** (`integrations.create`): Empresa*, TMS*, CS/GC*, Responsável operacional, Objetivo*, Descrição*, data de início, previsão de conclusão, próxima ação (descrição, responsável, data, observações) e observações gerais. Status sempre **Início**. Empresa/TMS novos podem ser cadastrados na hora por quem já tem `users.manage` / `categories.manage`. Reenvio do formulário **não duplica** (identificador de requisição). Descrição em texto simples (parágrafos e listas com "- "), exibida sem interpretar HTML.

**Detalhe:** resumo, descrição, **Histórico do acompanhamento**, **Histórico de alterações** e ações conforme permissão.

- **Histórico do acompanhamento** (`integrations.log`): atividades individuais e imutáveis em ordem cronológica (invertível), com tipo (configurável: Reunião, Contato com o cliente, Atividade técnica, Configuração de sistema, Teste de integração, Validação de dados, Pendência identificada, Ação executada, Decisão tomada, Próxima etapa, Observação), descrição, resultado, próxima ação e data prevista. **Autor e data/hora vêm do servidor**. Correção/remoção de atividades só por `integrations.admin` (remoção lógica, registrada).
- **Alterar** (`integrations.edit`): modo de edição com Salvar alterações / Cancelar (confirma ao descartar); só os campos **efetivamente alterados** geram registros; sem mudança, nada é gravado.
- **Auditoria de alterações** (`integrations.history`, tabela **imutável**): para cada campo alterado, uma linha com usuário (id e nome), data/hora do banco, campo, valor anterior e novo, tipo de operação e identificador da operação (agrupa campos salvos juntos). Valores de empresa/TMS/pessoas são gravados pelo **nome**. Card e auditoria são gravados **na mesma transação**; falha reverte tudo.
- **Concorrência**: edição e ações exigem a `version` do registro; se outra pessoa alterou, retorna `409 VERSION_CONFLICT` com os dados atuais e a tela oferece "Recarregar dados atuais" — nada é sobrescrito.
- **Status:** Início ↔ Acompanhamento pela edição (`integrations.status`). **Finalizar** (`integrations.finish`) pede confirmação e resumo do resultado (data, observações finais, pendências remanescentes; guarda quem finalizou). **Reabrir** (`integrations.reopen`) exige motivo e o novo status; a finalização anterior fica no histórico. **Arquivar/Restaurar** (`integrations.archive`). Nada é apagado.
- **Próxima ação vencida:** existe data, status ≠ Finalizado, não arquivada e data anterior a hoje (fuso `APP_TIMEZONE`); sem data nunca é atraso.
- Não há notificações automáticas nem integrações externas para as próximas ações.

---

## 18. Administração: usuários, empresas, auditoria e bloqueios

### Usuários e permissões (`users.manage`)

- **Lista e painel de permissões** (mestre/detalhe): busca, filtro Interno/Externo, e, ao selecionar um usuário, **permissões em caixas de seleção aplicadas na hora** (concede/revoga; volta a "herdar do perfil" quando coincide com o padrão), com banner de confirmação. Permissões internas não podem ser concedidas a externos. Não é possível revogar a própria permissão `users.manage`.
- **Vincular novo usuário**: nome, e-mail, tipo, empresa, perfis, senha (ou temporária gerada).
- **Detalhe do usuário**: perfis, permissões individuais (herdar/conceder/revogar, com quem e quando), **redefinir senha** (senha temporária exibida uma vez; encerra sessões), **ativar/desativar**, **anonimizar (LGPD)**.

### Empresas (`users.manage`)

- Tela mestre/detalhe: usuários à esquerda ("Principal: empresa · N empresas"); à direita **Empresas de {usuário}** com caixas de seleção (a empresa principal fica marcada e fixa) para conceder **acesso a várias empresas**. O acesso extra vale para a visão de **tickets da empresa**.
- Tabela **Empresa · CNPJ · Sistemas contratados · Usuários com acesso**; cadastro/edição de empresa (nome único sem diferenciar maiúsculas, documento, ativa/inativa) e dos **sistemas contratados**. Alterações de acesso e de sistemas contratados vão para a auditoria (antes/depois).

### Auditoria (`audit.view`)

- Tabela imutável: **Data e hora · Responsável · Tela · Ação (código) · Item · IP · O que mudou**. A coluna **Tela** agrupa as ações por módulo (Artigos, Categorias e sistemas, Comunicados, Atualizações, Atualizações dos Cards, Integração de Clientes, Documentos, Tickets, Usuários e permissões, Empresas, Autenticação, Outros).
- Filtros: pesquisa livre (ação, item ou responsável), tela, responsável e data inicial. **Ver alterações** mostra, campo a campo, **Antes** (vermelho) e **Depois** (verde) com expansão de valores longos; sem diferenças de campo aparece "Sem alteração de campo".
- Campos sensíveis (`password`, `token`, `secret`, `apiKey`…) são removidos antes de gravar. O banco impede `UPDATE`/`DELETE` de registros.

### Bloqueios de edição (`locks.release`)

Lista de artigos em edição (quem, desde quando, última renovação, validade) com **Liberar** (exige motivo, auditado). Ver seção 9.

### Painel interno (`/interno`)

Saudação, atalhos (Novo artigo, Artigos, Atendimento, Comunicados, Documentos, Auditoria — conforme permissões), situação dos tickets em andamento e "Meus artigos recentes".

---

## 19. Segurança, privacidade (LGPD) e regras transversais

| Tema | Regra |
|---|---|
| Autorização | Sempre no backend, em cada rota, com o estado atual do recurso; permissões lidas do banco a cada requisição (revogação vale na próxima requisição) |
| Isolamento | Externos nunca acessam conteúdo, arquivos, fontes de IA ou APIs internas; IDs diretos não contornam a política |
| Arquivos | O acesso herda do recurso proprietário (artigo, comunicado, ticket, observação interna, documento, documento de apoio); uploads ainda não vinculados: só quem enviou; respostas com `nosniff`, `Content-Disposition` e CSP `sandbox`; leitura com suporte a Range |
| Uploads | Tipo real por assinatura (magic bytes); SVG e executáveis rejeitados; limites por tipo; nomes sanitizados |
| Conteúdo | Sanitização no servidor (lista de permissões); textos de tickets e integrações sempre com escape; CSP restritiva (Helmet, `frame-ancestors 'none'`) |
| SQL | Apenas consultas parametrizadas |
| Cookies/CSRF | `httpOnly`, `SameSite=Lax`, `Secure` em produção, token CSRF + verificação de `Origin` |
| Limites de requisição | Login, chat, auxílio da IA, abertura de tickets e webhooks do Jira (em memória por instância) |
| Imutabilidade | `audit_logs`, `article_history`, `article_versions`, `ticket_messages`, `ticket_internal_notes`, `ticket_events` e `integration_changes` rejeitam `UPDATE`/`DELETE` por trigger |
| Logs | Cookies, `Authorization` e `X-CSRF-Token` removidos; credenciais do Jira nunca expostas |
| Cache | `private, no-store` para conteúdo restrito; artigos sempre `no-store` na API |
| Webhooks do Jira | Autenticados por segredo compartilhado (comparação em tempo constante) |
| LGPD | Minimização no chat; retenção de conversas (180 dias); **anonimizar usuário** substitui nome e e-mail, bloqueia acesso, encerra sessões e apaga conversas de IA preservando tickets, artigos e auditoria; sugestão de artigo a partir de ticket gera rascunho **interno** com aviso para remover dados de clientes |

Auditoria registra: login/logout/falhas, permissões, perfis, usuários, artigos, bloqueios, tickets, documentos, arquivos, comunicados, integrações, cards, empresas e acessos.

---

## 20. Pendências, limitações e decisões

**Decisões de produto registradas**

- **Comunicados**: cadastro só para internos; leitura conforme a visibilidade do comunicado (Externo é público para clientes). Decidido a partir do design do pacote Logaz.
- **Atualizações** (releases do Jira) e **Comunicados** são telas separadas.
- **Contas de teste** existem apenas para validação e devem ser removidas em produção.

**Limitações conhecidas**

- Integração com o Jira **validada com respostas simuladas**; falta validar com cards reais (ex.: CHL-245) após configurar credenciais.
- IA generativa validada com provedor simulado (sem chave real nos testes).
- O Jira não expõe comentários apagados nem versões intermediárias de comentários editados: o módulo registra a remoção/edição, mas guarda só o último texto.
- Histórico de cards anterior ao primeiro webhook só existe se a API do Jira estiver configurada.
- "Esqueceu sua senha?" não envia e-mail: orienta procurar o administrador.
- Permissões são definidas em código (não há cadastro de novas permissões em tela).
- CS e GC não são papéis distintos: o campo aceita qualquer usuário interno ativo.
- Rate limit em memória por instância (com várias instâncias usar Redis).
- `.doc` exige LibreOffice no servidor (`DOC_CONVERSION_ENABLED`).
- A imagem de referência dos vídeos citada no pedido original não foi recebida; o player foi feito pela descrição.
- O deploy do **frontend** na Vercel não inclui a **API**: é preciso hospedar o backend (Node + PostgreSQL) separadamente e apontar `/api` para ele; sem isso o login do site publicado não funciona.
- Banco temporário no **Neon**: preparar com o fluxo do GitHub Actions `Preparar banco Neon` (ver `docs/NEON.md`).

---

## 21. Referência técnica

### 21.1 Permissões e perfis

Permissões efetivas = (perfis ∪ concessões) − revogações, filtradas pelo tipo. **Todas as listadas abaixo são "somente internas"**, exceto `tickets.view_company`.

| Grupo | Chave | O que permite |
|---|---|---|
| Artigos | `articles.view_internal` | Ver artigos e documentos internos |
| | `articles.create` | Criar artigos e rascunhos |
| | `articles.edit` | Editar os próprios artigos |
| | `articles.edit_others` | Editar artigos de outros |
| | `articles.publish` | Publicar e alterar artigos publicados |
| | `articles.unpublish` | Despublicar |
| | `articles.archive` | Arquivar e restaurar |
| | `articles.history` | Histórico e versões |
| Conteúdo | `categories.manage` | Categorias, sistemas, tags, sinônimos |
| | `announcements.manage` | Cadastrar/publicar comunicados |
| | `updates.manage` | Gerir atualizações vindas do Jira |
| | `cards.view` / `cards.sync` | Consultar / sincronizar cards do Jira |
| | `documents.manage` | Documentos de apoio e importados |
| Integração de Clientes | `integrations.view`, `.create`, `.edit`, `.log`, `.status`, `.finish`, `.reopen`, `.history`, `.archive`, `.admin` | Consultar, criar, editar, registrar atividades, mudar status, finalizar, reabrir, ver histórico de alterações, arquivar/restaurar, administrar tipos e atividades |
| Administração | `users.manage` | Usuários, empresas, perfis, permissões |
| | `audit.view` | Auditoria |
| | `locks.release` | Liberar bloqueios de edição |
| Tickets | `tickets.support` | Atender tickets sem responsável ou atribuídos a si |
| | `tickets.manage` | Ver todos e atribuir |
| | `tickets.view_company` (não interna) | Ver tickets da(s) empresa(s) do usuário |

**Perfis iniciais**

| Perfil | Permissões |
|---|---|
| Administrador | Todas as internas (exceto `tickets.view_company`); podem ser revogadas individualmente |
| Editor | `articles.view_internal`, `.create`, `.edit`, `.edit_others`, `.history` (sem publicar) |
| Autor | `articles.view_internal`, `.create`, `.edit`, `.history` |
| Suporte técnico | `articles.view_internal`, `tickets.support`, `cards.view` |
| Integração de clientes | `articles.view_internal`, `integrations.view/.create/.edit/.log/.status/.finish/.history` |
| Leitor interno | `articles.view_internal` |
| Usuário externo | Nenhuma permissão administrativa (artigos externos, IA e os próprios tickets) |

### 21.2 Vocabulário e enumerações

- **Status de artigo:** Rascunho, Publicado, Despublicado, Arquivado. **Visibilidade:** Interno, Externo.
- **Operações de artigo:** Criação, Edição, Publicação, Despublicação, Alteração de visibilidade, Arquivamento, Restauração do arquivo, Restauração de versão, Salvamento rejeitado.
- **Blocos de destaque:** Atenção, Alerta, Importante, Dica, Informação.
- **Status de ticket:** Aberto, Em triagem, Em atendimento, Aguardando usuário, Aguardando equipe técnica, Resolvido, Fechado.
  - Transições permitidas à equipe: Aberto → (triagem, atendimento, aguardando usuário/técnica, resolvido, fechado); Em triagem → (atendimento, aguardando usuário/técnica, resolvido, fechado); Em atendimento → (triagem, aguardando usuário/técnica, resolvido, fechado); Aguardando usuário → (triagem, atendimento, aguardando técnica, resolvido, fechado); Aguardando técnica → (atendimento, aguardando usuário, resolvido); Resolvido → (atendimento, fechado); Fechado → (triagem).
  - Agrupamento da fila: **pendentes** (aguardando usuário, aguardando técnica, triagem) → **em aberto** (aberto, atendimento) → **finalizados** (resolvido, fechado).
- **Prioridades:** Baixa, Média, Alta, Crítica. **Tipos de pedido:** Incidente/erro, Dúvida, Solicitação, Sugestão de melhoria. **Mensagens públicas do ticket:** Mensagem do usuário, Resposta do suporte, Solicitação de informações, Solução aplicada.
- **Documentos importados — processamento:** Aguardando, Em processamento, Processado, Processado com avisos, Falha. **Revisão:** Aguardando revisão, Aprovado, Rejeitado.
- **Documentos de apoio — tipos:** Requisição, Documentação de API, PDF/Manual, Planilha, Outro.
- **Categorias de comunicado:** Novidade, Alteração de funcionalidade, Manutenção, Comunicado.
- **Status de integração:** Início, Acompanhamento, Finalizado. **Operações de auditoria de integração:** Criação, Alteração, Mudança de status, Finalização, Reabertura, Arquivamento, Restauração, Atividade corrigida, Atividade removida.
- **Tipos de evento de card Jira:** card criado, mudança de status, mudança de responsável, descrição alterada, prioridade alterada, campo alterado, novo comentário, comentário editado, comentário removido.
- **Status Jira de referência (CHL/RISK1):** `00 - Backlog`, `01 - Para Desenvolver`, `Em Code Review`, `Em Desenvolvimento`, `Em Teste Homolog`, `Para Atualizar Homolog`, `Para Deploy`, `Para Testar Homolog`, `VALIDACAO PO`, `PRONTO` — o Jira é a fonte oficial; status novos aparecem sem alterar código.

### 21.3 API (resumo)

Todas as rotas ficam sob `/api`. Mutações exigem `X-CSRF-Token` (exceto webhooks, que usam segredo). Erros seguem `{ error: { code, message, details? } }`; validação retorna `422`, conflito de versão `409`.

| Área | Rotas principais |
|---|---|
| Sistema | `GET /health`, `GET /config` (nome, fuso, limites, IA, contas de teste), `GET /home`, `GET /taxonomy` |
| Autenticação | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/change-password` |
| Artigos | `GET/POST /articles`, `GET /articles/:idOrSlug`, `PUT /articles/:id`, `POST /articles/:id/{publish,unpublish,archive,unarchive}`, `GET /articles/:id/{history,versions,versions/:v}`, `POST /articles/:id/versions/:v/restore`, `GET /search` |
| Bloqueio | `GET/POST/DELETE /articles/:id/lock`, `POST …/lock/heartbeat`, `POST …/lock/beacon`, `GET /locks`, `POST /locks/:articleId/release` |
| Taxonomia | `POST/PUT/DELETE /categories`, `/systems`, `/tags`, `/search-synonyms` |
| Arquivos | `POST /files`, `POST /files/:id/cover`, `GET /files/:id`, `GET /files/:id/meta` |
| IA | `POST /chat`, `GET /chat/:id`, `GET /ai/status`, auxílio de descrição |
| Tickets (cliente) | `GET /tickets/form-options`, `POST /tickets`, `GET /tickets/mine`, `GET /tickets/:id`, `POST /tickets/:id/{messages,confirm-resolution,reopen}` |
| Tickets (suporte) | `GET /support/tickets`, `GET /support/tickets/:id`, `POST …/{reply,notes,status,assign,suggest-article,articles}`, `PUT …/{classification,resolution}`, `DELETE …/articles/:id`, `GET /support/article-picker` |
| Documentos importados | `GET/POST /documents`, `GET/PUT/DELETE /documents/:id`, `POST /documents/:id/{approve,reject,reprocess,create-article,articles}` |
| Documentos de apoio | `GET/POST /support-documents`, `DELETE /support-documents/:id` |
| Comunicados | `GET/POST /announcements`, `GET/PUT /announcements/:id`, `POST …/{publish,unpublish}` |
| Atualizações (Jira) | `GET /updates`, `GET /updates/:id`, `GET /updates/integration`, `PUT /updates/:id`, `POST /updates/:id/release-control`, `POST /updates/sync`, webhook `POST /integrations/jira/webhook` |
| Cards (Jira) | `GET /cards`, `GET /cards/:key`, `GET /cards/:key/events`, `GET /cards/sync-status`, `POST /cards/sync`, webhook `POST /integrations/jira/cards/webhook` |
| Integração de Clientes | `GET/POST /integrations`, `GET/PUT /integrations/:id`, `POST /integrations/:id/{finish,reopen,archive,restore}`, `GET/POST /integrations/:id/activities`, `PUT/DELETE …/activities/:activityId`, `GET /integrations/:id/changes`, `GET /integrations/lookups`, `POST/PUT /integrations/activity-types` |
| Usuários/empresas | `GET/POST /users`, `GET/PUT /users/:id`, `PUT /users/:id/{roles,permissions/:key,company-access}`, `GET /users/:id/company-access`, `POST /users/:id/{reset-password,anonymize}`, `GET /users/agents`, `GET /admin/permissions`, `GET/POST/PUT /companies`, `GET /companies/overview`, `PUT /companies/:id/systems` |
| Auditoria | `GET /audit` (filtros: `q`, `screen`, `actor`, `action`, `entityType`, `entityId`, datas) |

### 21.4 Modelo de dados

Migrações em `server/src/db/migrations/` (aplicadas por `npm run migrate`; controle em `schema_migrations`, com *advisory lock*):

| Migração | Conteúdo |
|---|---|
| `001_initial_schema` | Empresas, sistemas, usuários, perfis, permissões, sessões, categorias, tags, sinônimos, arquivos, artigos (+ tags, versões, histórico, bloqueios), comunicados, documentos importados e trechos indexados, conversas e fontes de IA, tickets (+ mensagens, observações internas, eventos, anexos, artigos vinculados), auditoria |
| `002_updates_and_announcements` | Atualizações do Jira, comunicados vinculados a vários sistemas |
| `003_jira_cards` | Cards, eventos, execuções de sincronização, webhooks recebidos |
| `004_customer_integrations` | Integrações, atividades, tipos de atividade, histórico de alterações (imutável) |
| `005_public_announcements_and_reads` | Visibilidade de comunicados e histórico de leitura por usuário |
| `006_support_documents` | Documentos de apoio |
| `007_company_access` | Acesso multi-empresa e sistemas contratados |

Características: timestamps `timestamptz` gerados pelo banco (UTC); chaves estrangeiras com `RESTRICT` para preservar histórico; `CHECK` de status/visibilidade; artigo publicado com campos obrigatórios; índices GIN (pesquisa) e de trigramas; duplicidade de documento importado impedida por SHA-256; versões e históricos com *triggers* de imutabilidade.

### 21.5 Variáveis de ambiente

| Grupo | Variável (padrão) |
|---|---|
| Servidor | `NODE_ENV`, `HOST` (0.0.0.0), `PORT` (3000), `PUBLIC_BASE_URL`, `SERVE_WEB` (true), `WEB_DIST_DIR`, `LOG_LEVEL` (info), `TRUST_PROXY` (false) |
| Banco | `DATABASE_URL` (obrigatória), `DATABASE_SSL` (false) |
| Aplicação | `APP_NAME`, `APP_TIMEZONE` (America/Sao_Paulo), `APP_SECRET` (≥32 caracteres em produção) |
| Sessão | `SESSION_TTL_HOURS` (12), `COOKIE_SECURE` (false) |
| Acesso | `PUBLIC_ANONYMOUS_ACCESS` (**false** = login obrigatório) |
| Bloqueio | `LOCK_TTL_SECONDS` (120), `LOCK_HEARTBEAT_SECONDS` (30) |
| Armazenamento | `STORAGE_DRIVER` (local\|s3), `STORAGE_LOCAL_DIR`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `SIGNED_URL_TTL_SECONDS` (300) |
| Uploads | `MAX_IMAGE_MB` (10), `MAX_VIDEO_MB` (200), `MAX_ATTACHMENT_MB` (25), `MAX_DOCUMENT_MB` (30), `FFMPEG_PATH`, `DOC_CONVERSION_ENABLED`, `SOFFICE_PATH` |
| Tickets | `TICKET_REOPEN_WINDOW_DAYS` (7) |
| IA | `ANTHROPIC_API_KEY`, `AI_MODEL` (claude-opus-5-5), `AI_EFFORT` (low), `AI_SERVER_FALLBACKS`, `AI_MAX_SOURCES` (6), `AI_TIMEOUT_MS` (60000), `VOYAGE_API_KEY`, `EMBEDDINGS_MODEL` (voyage-3.5), `AI_CONVERSATION_RETENTION_DAYS` (180) |
| Jira — atualizações | `JIRA_WEBHOOK_SECRET`, `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEYS`, `JIRA_RELEASE_FIELD` (fixVersions), `JIRA_AUDIENCE_FIELD` (Público alvo), `JIRA_DONE_STATUSES`, `JIRA_SYNC_MINUTES` (0) |
| Jira — cards | `JIRA_CARD_PROJECTS` (CHL,RISK1), `JIRA_CARDS_SYNC_MINUTES` (0), `JIRA_SHARED_ACCOUNTS` |
| Testes | `TEST_LOGINS_ENABLED` (false), `SEED_TEST_USERS`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_DEMO`, `SEED_DEMO_PASSWORD` |
| Limites | `RATE_LIMIT_LOGIN_PER_MIN` (10), `RATE_LIMIT_CHAT_PER_MIN` (20), `RATE_LIMIT_TICKETS_PER_HOUR` (20) |

Detalhes e exemplos: `docs/VARIAVEIS_DE_AMBIENTE.md` e `.env.example`.

### 21.6 Implantação

- **Docker**: `Dockerfile` em duas etapas (build com Node 22; execução com ffmpeg, `tini`, LibreOffice opcional via `WITH_LIBREOFFICE=true`) e `docker-compose.yml`.
- **Sem Docker**: `npm ci` → `npm run build` → `npm run migrate` → `npm run seed` → `npm start` (variáveis acima).
- **Frontend na Vercel**: `web/vercel.json` (Vite, SPA). A API precisa de hospedagem própria (Render, Railway, Fly etc.).
- **Banco Neon (temporário)**: criar `NEON_DATABASE_URL` como secret do GitHub e rodar o fluxo `Preparar banco Neon` (`docs/NEON.md`); o SQL Editor do Neon aceita um comando por vez, então não serve para criar o esquema.
- Produção: HTTPS com `COOKIE_SECURE=true` e `TRUST_PROXY=true`, `APP_SECRET` forte, usuário do banco sem superusuário, backups do banco e dos arquivos.
- Documentos relacionados: `docs/IMPLANTACAO.md`, `docs/NEON.md`.

### 21.7 Testes

- **Backend (Vitest, banco PostgreSQL real recriado a cada execução):** 174 testes em 16 arquivos — artigos, bloqueios concorrentes, permissões, pesquisa sem acento, arquivos/uploads, tickets, documentos, IA (provedor simulado), comunicados, atualizações e Jira, cards, integrações de clientes (auditoria, concorrência, transação), documentos de apoio, auditoria e acesso multi-empresa.
- **Frontend (Vitest):** 5 testes.
- **Ponta a ponta (Playwright):** 13 cenários (pesquisa e artigo com vídeo, acesso interno negado a externos, editor, bloqueio de edição, ticket com anexo obrigatório, chat, responsivo, contas de teste, cards, integração de clientes, documentos/usuários/empresas, pré-visualização de comunicado).
- Comandos: `npm test`, `npm run typecheck`; e2e: `E2E_BASE_URL=http://localhost:3000 npm run e2e -w web` com a aplicação rodando.
- Relatório: `docs/RELATORIO_DE_TESTES.md`.

### 21.8 Contas de teste

Somente para validação (criadas por `SEED_TEST_USERS=true` e exibidas no login com `TEST_LOGINS_ENABLED=true`):

| Conta | Perfil | Senha |
|---|---|---|
| `interno@teste.com` | Interno — administrador | `Teste@12345` |
| `externo@teste.com` | Externo — cliente (empresa "Empresa de Teste") | `Teste@12345` |
| `admin@exemplo.com` | Administrador inicial do seed local | `Admin12345!` |

**Remova essas contas e desligue `TEST_LOGINS_ENABLED` antes de uso real.**

### 21.9 Design (tema Logaz)

- **Cores:** verde primário `#064B3A` (hover `#0A6650`), menta `#19B987` (CTA/foco; hover `#15A376`; texto sobre menta `#04291F`), link `#0787E8`, fundo `#F4F6F5`, superfície `#FFFFFF`, borda `#E8E8E8`/`#D8D8D8`, texto `#202020`/`#555`/`#777`.
- **Semânticas (texto/fundo):** sucesso `#04291F`/`#D6F3E7`; informação `#0A4C8A`/`#DCEBF8`; atenção `#6B4A00`/`#FBEFC9`; aguardando `#6B3A00`/`#FBE3CC`; erro `#8C1D18`/`#FBE0DE`; neutro `#444`/`#EDEDED`; roxo `#44288A`/`#EFE8FB`.
- **Tipografia:** fonte do sistema; H1 de página 26 px/600; hero 34 px/300; corpo 15 px.
- **Componentes:** cartões com raio 8 px, botões 5 px, campos 4 px; tabelas com cabeçalho em maiúsculas 12 px; indicadores com borda superior colorida; status sempre com texto além da cor; foco visível em menta; responsivo (grades que reempilham, menu lateral que sobe, tabelas com rolagem horizontal).
- Detalhes das telas e diferenças em relação ao protótipo: `docs/FRONTEND_LOGAZ.md`. Logo em `web/public/logaz-logo.png`.

### 21.10 Mapa do repositório

```
shared/src/            permissions.ts · domain.ts · uploads.ts   (regras compartilhadas)
server/src/
  app.ts · config.ts · jobs.ts · index.ts
  auth/                plugin · context · policies               (sessão, permissões, regras de acesso)
  db/                  pool · migrate · rbac · seed · migrations/
  lib/                 audit · crypto · uploads · storage · sanitize · text · validate · errors
  modules/
    auth.routes · users.routes · taxonomy.routes · audit.routes
    announcements.routes · files.routes · support-documents.routes
    articles/ (rotas, serviço, bloqueio, pesquisa)
    tickets/ · documents/ · ai/
    updates/ (Jira: releases) · cards/ (Jira: cards) · integrations/ (Integração de Clientes)
  cli/                 migrate · seed
server/test/           suíte de testes de backend
web/src/
  App.tsx (rotas) · main.tsx
  components/          Layout · ChatWidget · ui · editor/ · content/ · TicketTimeline · LockBanner
  pages/               Home · Search (resultados) · Article · Login · Account · Updates · Announcements
                       tickets/ · support/ · internal/ (Admin, Users, Documents, SupportDocuments, Cards, Integrations, Taxonomy, ArticleEditor, ArticleHistory)
  styles/              global.css · content.css
  lib/                 api · format · types
web/e2e/               testes ponta a ponta (Playwright)
docs/                  documentação (este arquivo, arquitetura, permissões, variáveis, implantação, módulos…)
.github/workflows/     neon-setup.yml
```
