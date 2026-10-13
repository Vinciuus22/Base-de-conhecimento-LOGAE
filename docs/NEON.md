# Banco de dados no Neon (temporário)

O Neon é PostgreSQL gerenciado e aceita as extensões que o projeto usa (`pgcrypto`, `unaccent`, `pg_trgm`), então as migrações rodam sem alteração.

## 1. Criar o banco e obter a conexão
Pela Vercel: projeto → **Storage → Create Database → Neon** (ou Marketplace → Neon) e conecte ao projeto. A integração cria as variáveis `DATABASE_URL` (conexão com pooler) e `DATABASE_URL_UNPOOLED` (conexão direta).

## 2. Variáveis do backend
| Variável | Valor |
|---|---|
| `DATABASE_URL` | URL do Neon com `?sslmode=require` |
| `DATABASE_SSL` | `true` |
| `APP_SECRET` | texto aleatório com 32+ caracteres |
| `PUBLIC_BASE_URL` | endereço público do frontend |
| `PUBLIC_ANONYMOUS_ACCESS` | `false` (login obrigatório) |

## 3. Criar as tabelas e os usuários (uma vez, da sua máquina)
Use a URL **direta** (`DATABASE_URL_UNPOOLED`) para as migrações:
```
export DATABASE_URL='postgres://...neon.tech/neondb?sslmode=require'
export DATABASE_SSL=true
npm ci
npm run migrate -w server
SEED_TEST_USERS=true SEED_ADMIN_EMAIL=admin@seudominio.com SEED_ADMIN_PASSWORD='UmaSenhaForte123!' npm run seed -w server
```
O seed cria `interno@teste.com` (administrador) e `externo@teste.com` (cliente), senha `Teste@12345`. Para vê-las como botões na tela de login, defina `TEST_LOGINS_ENABLED=true` no backend. Remova as contas de teste e a variável antes de usar de verdade.

## 4. Onde roda a API
O frontend (Vite) já está na Vercel, mas a API (Fastify) precisa de um processo Node ligado ao Neon e o frontend precisa chegar nela em `/api`. Enquanto isso não for definido, o login do site publicado não funciona.
