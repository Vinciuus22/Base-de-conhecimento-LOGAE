# Publicação em produção

## Opção A — Docker Compose

```bash
cp .env.example .env
# Edite: NODE_ENV=production, APP_SECRET (openssl rand -base64 48), PUBLIC_BASE_URL,
# COOKIE_SECURE=true, TRUST_PROXY=true, POSTGRES_PASSWORD e, se desejar, ANTHROPIC_API_KEY.
docker compose up -d --build
docker compose exec -e SEED_ADMIN_EMAIL=admin@empresa.com -e SEED_ADMIN_PASSWORD='SenhaForte123' app node dist/cli/seed.js
```

- Migrations são aplicadas automaticamente na inicialização (`MIGRATE_ON_START`).
- Arquivos ficam no volume `app-data` (`/data/storage`) — inclua-o no backup.
- Para importar `.doc`, construa com `docker compose build --build-arg WITH_LIBREOFFICE=true`
  e defina `DOC_CONVERSION_ENABLED=true`.

> Observação: o `Dockerfile` não pôde ser executado no ambiente em que o projeto foi
> desenvolvido (sem daemon Docker). Valide o build no seu pipeline antes do primeiro
> deploy.

## Opção B — Servidor Node.js

```bash
npm ci
npm run build
cd server
NODE_ENV=production node dist/cli/migrate.js
NODE_ENV=production node dist/index.js        # use systemd/PM2 para manter o processo
```

Requisitos: Node.js 22, `ffmpeg` (recomendado), PostgreSQL 16 com `postgresql-contrib`.
O build do frontend é lido na inicialização: após publicar um novo build, reinicie o
processo.

## Proxy reverso (exemplo nginx)

```nginx
server {
  listen 443 ssl http2;
  server_name kb.empresa.com.br;
  client_max_body_size 210m;            # >= MAX_VIDEO_MB
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_request_buffering off;        # uploads grandes
  }
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
}
```

## Banco de dados

```sql
CREATE ROLE kb_app LOGIN PASSWORD '...';
CREATE DATABASE kb OWNER kb_app;
-- As extensões unaccent, pg_trgm e pgcrypto são criadas pela migration;
-- em serviços gerenciados, habilite-as previamente se o usuário não puder criá-las.
```

## Checklist

- [ ] `NODE_ENV=production`, `APP_SECRET` forte, `COOKIE_SECURE=true`, `TRUST_PROXY=true`
- [ ] HTTPS e HSTS no proxy
- [ ] Backup diário do PostgreSQL e do armazenamento (ou versionamento do bucket S3)
- [ ] Bucket S3 **privado** (sem acesso público) quando `STORAGE_DRIVER=s3`
- [ ] `ANTHROPIC_API_KEY`/`VOYAGE_API_KEY` em cofre de segredos
- [ ] Criar o administrador inicial e trocar a senha no primeiro acesso
- [ ] Revisar perfis e permissões individuais
- [ ] Monitorar `GET /api/health` e os logs (nível `warn`/`error`)
- [ ] Com várias instâncias: rate limit compartilhado (Redis) — ver pendências
