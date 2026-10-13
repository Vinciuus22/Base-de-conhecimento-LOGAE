# Base de Conhecimento LOGAE

Aplicação web de Base de Conhecimento com **ambiente interno e externo**, **editor de artigos**,
**histórico de alterações**, **bloqueio de edição simultânea**, **pesquisa em português**,
**chat com IA fundamentado em fontes autorizadas**, **tickets de suporte** com a área
“Meus tickets” e **importação de documentos PDF/Word**.

| Camada | Tecnologia |
|---|---|
| Frontend | React 19, Vite 6, TipTap 3 (editor), TanStack Query, React Router 7 |
| Backend | Node.js 22, Fastify 5, TypeScript, Zod |
| Banco de dados | PostgreSQL 16 (`unaccent`, `pg_trgm`, pesquisa textual em português) |
| Arquivos | Disco local privado ou S3 compatível (URLs temporárias assinadas) |
| Mídia | sharp (miniaturas de imagens), ffmpeg (miniaturas de vídeos) |
| Documentos | unpdf (PDF), mammoth (DOCX), LibreOffice opcional (DOC) |
| IA | Claude (Anthropic API) + Voyage AI opcional para pesquisa semântica |
| Testes | Vitest (backend e frontend) e Playwright (ponta a ponta) |

## Documentação

- [Arquitetura, plano técnico e modelo de dados](docs/ARQUITETURA.md)
- [Permissões e segurança (inclui LGPD)](docs/PERMISSOES_E_SEGURANCA.md)
- [Variáveis de ambiente e dependências externas](docs/VARIAVEIS_DE_AMBIENTE.md)
- [Publicação em produção](docs/IMPLANTACAO.md)
- [Relatório de testes e pendências](docs/RELATORIO_DE_TESTES.md)

## Execução local

Pré-requisitos: Node.js 22+, PostgreSQL 16+ (com as extensões `unaccent` e `pg_trgm`,
incluídas no pacote `postgresql-contrib`) e, opcionalmente, `ffmpeg` para gerar
miniaturas de vídeos.

```bash
# 1. Dependências
npm install

# 2. Banco de dados (exemplo)
createdb kb_dev

# 3. Configuração
cp .env.example server/.env        # ajuste DATABASE_URL e, se desejar, ANTHROPIC_API_KEY

# 4. Migrations + administrador inicial (+ dados de demonstração opcionais)
npm run migrate
SEED_ADMIN_EMAIL=admin@empresa.com SEED_ADMIN_PASSWORD='SenhaForte123' SEED_DEMO=true npm run seed

# 5. Desenvolvimento (dois terminais)
npm run dev:server     # API em http://localhost:3000
npm run dev:web        # interface em http://localhost:5173 (proxy para a API)
```

Com `SEED_DEMO=true` são criados usuários de exemplo (senha `Demo12345!`, alterável via
`SEED_DEMO_PASSWORD`): `editor@exemplo.com`, `publicador@exemplo.com` (editor com permissão
de publicação), `autor@exemplo.com`, `suporte@exemplo.com`, `leitor@exemplo.com`,
`cliente@exemplo.com` e `cliente2@exemplo.com` (externos), além de categorias, sistemas,
artigos internos/externos/rascunho e um comunicado. **Não use dados de demonstração em produção.**

### Executar como em produção (um único processo)

```bash
npm run build          # compila web/dist e server/dist
cd server && node dist/cli/migrate.js && node dist/index.js
```

O backend serve a interface compilada e a API na mesma porta.

## Testes

```bash
# Backend: requer um banco de testes vazio (é recriado a cada execução)
createdb kb_test
TEST_DATABASE_URL=postgres://usuario:senha@localhost:5432/kb_test npm test -w server

# Frontend (unitários)
npm test -w web

# Ponta a ponta: aplicação em execução com dados de demonstração
E2E_BASE_URL=http://localhost:3000 npm run e2e -w web
```

## Estrutura

```
shared/src      Regras compartilhadas (permissões, status, validação de YouTube, uploads)
server/src      API Fastify
  auth/         Sessão, CSRF, contexto e políticas de autorização centralizadas
  db/           Pool, migrations SQL, sincronização de perfis e seed
  lib/          Sanitização, armazenamento, uploads, auditoria, criptografia
  modules/      articles (serviço, bloqueio, pesquisa), tickets, ai, documents, ...
server/test     Testes de integração (PostgreSQL real) e unitários
web/src         Interface React (páginas públicas, ambiente interno, editor)
web/e2e         Testes Playwright
docs/           Documentação técnica
```

## Atualizações (Jira) e Comunicados

- **Atualizações**: vêm do Jira. Quando uma tarefa é concluída com o campo de release preenchido, ela aparece em `/atualizacoes`. O campo **Público alvo** define quem enxerga (clientes ou só internos). Clientes e visitantes apenas visualizam. Configuração em `docs/VARIAVEIS_DE_AMBIENTE.md`.
- **Comunicados** (`/comunicados`): área separada, só para usuários internos; quem tem `announcements.manage` cadastra avisos com imagens e vídeos e os vincula a uma ou mais plataformas.
- **Contas de teste** (apenas desenvolvimento): `interno@teste.com` e `externo@teste.com`, senha `Teste@12345` (`SEED_TEST_USERS=true` + `TEST_LOGINS_ENABLED=true`).
- **Atualizações dos Cards** (`/interno/cards`): painel interno somente de consulta com os cards do Jira (CHL e RISK1) e o histórico de alterações. Veja `docs/ATUALIZACOES_DOS_CARDS.md`.
