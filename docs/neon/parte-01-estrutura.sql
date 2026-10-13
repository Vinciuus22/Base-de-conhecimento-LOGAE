-- =====================================================================
-- Base de Conhecimento — esquema inicial
-- Todos os timestamps são armazenados como timestamptz (UTC) e gerados
-- pelo banco/backend. A apresentação usa o fuso horário configurado.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Configuração de pesquisa em português, sem acentuação.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'pt_unaccent') THEN
    CREATE TEXT SEARCH CONFIGURATION pt_unaccent (COPY = portuguese);
    ALTER TEXT SEARCH CONFIGURATION pt_unaccent
      ALTER MAPPING FOR hword, hword_part, word WITH unaccent, portuguese_stem;
  END IF;
END$$;

-- unaccent() não é IMMUTABLE; este wrapper permite uso em índices.
CREATE OR REPLACE FUNCTION immutable_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- Impede UPDATE/DELETE em tabelas de auditoria (registros imutáveis).
CREATE OR REPLACE FUNCTION prevent_audit_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Registros de auditoria são imutáveis (tabela %)', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END$$;

-- ---------------------------------------------------------------------
-- Empresas, sistemas, usuários, perfis e permissões
-- ---------------------------------------------------------------------
CREATE TABLE companies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  document    text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX companies_name_uq ON companies (lower(name));

CREATE TABLE systems (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  slug        text NOT NULL UNIQUE,
  description text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL CHECK (length(trim(name)) > 0),
  email          text NOT NULL,
  password_hash  text NOT NULL,
  user_type      text NOT NULL CHECK (user_type IN ('internal', 'external')),
  company_id     uuid REFERENCES companies(id) ON DELETE RESTRICT,
  active         boolean NOT NULL DEFAULT true,
  anonymized_at  timestamptz,
  failed_logins  integer NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));
CREATE INDEX users_company_idx ON users (company_id);

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text,
  user_type   text NOT NULL CHECK (user_type IN ('internal', 'external'))
);

CREATE TABLE permissions (
  key           text PRIMARY KEY,
  label         text NOT NULL,
  description   text NOT NULL,
  internal_only boolean NOT NULL
);

CREATE TABLE role_permissions (
  role_id        uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE user_roles (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  granted_by uuid REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

-- Concessões ('grant') e revogações ('deny') individuais.
CREATE TABLE user_permissions (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  effect         text NOT NULL CHECK (effect IN ('grant', 'deny')),
  granted_by     uuid REFERENCES users(id),
  granted_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission_key)
);

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text NOT NULL UNIQUE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token   text NOT NULL,
  ip           text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------
-- Taxonomia
-- ---------------------------------------------------------------------
CREATE TABLE categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  slug        text NOT NULL UNIQUE,
  description text,
  icon        text,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tags (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(trim(name)) > 0),
  slug       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Sinônimos/termos alternativos usados para ampliar a pesquisa.
CREATE TABLE search_synonyms (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term       text NOT NULL,
  synonyms   text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX search_synonyms_term_uq ON search_synonyms (lower(immutable_unaccent(term)));

-- ---------------------------------------------------------------------
-- Arquivos (metadados — o conteúdo fica no armazenamento de objetos)
-- ---------------------------------------------------------------------
CREATE TABLE files (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key      text NOT NULL UNIQUE,
  original_name    text NOT NULL,
  mime_type        text NOT NULL,
  size_bytes       bigint NOT NULL CHECK (size_bytes >= 0),
  sha256           text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('image', 'video', 'attachment', 'document', 'thumbnail')),
  -- Contexto proprietário que define a autorização de acesso ao arquivo.
  owner_type       text CHECK (owner_type IN ('article', 'announcement', 'ticket', 'ticket_note', 'document')),
  owner_id         uuid,
  parent_file_id   uuid REFERENCES files(id) ON DELETE CASCADE,
  width            integer,
  height           integer,
  thumbnail_id     uuid REFERENCES files(id) ON DELETE SET NULL,
  uploaded_by      uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
CREATE INDEX files_owner_idx ON files (owner_type, owner_id);
CREATE INDEX files_uploader_idx ON files (uploaded_by) WHERE owner_id IS NULL;

-- ---------------------------------------------------------------------
-- Artigos
-- ---------------------------------------------------------------------
CREATE TABLE articles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,
  title           text NOT NULL CHECK (length(trim(title)) > 0),
  summary         text NOT NULL DEFAULT '',
  content_html    text NOT NULL DEFAULT '',
  content_text    text NOT NULL DEFAULT '',
  category_id     uuid REFERENCES categories(id) ON DELETE RESTRICT,
  system_id       uuid REFERENCES systems(id) ON DELETE RESTRICT,
  keywords        text[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'unpublished', 'archived')),
  visibility      text NOT NULL CHECK (visibility IN ('internal', 'external')),
  author_id       uuid NOT NULL REFERENCES users(id),
  updated_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz,
  published_by    uuid REFERENCES users(id),
  version         integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  view_count      bigint NOT NULL DEFAULT 0,
  search_vector   tsvector,
  -- Artigo publicado precisa ter todos os campos obrigatórios.
  CONSTRAINT articles_published_complete CHECK (
    status <> 'published' OR (
      category_id IS NOT NULL AND system_id IS NOT NULL AND length(trim(summary)) > 0
      AND length(trim(content_text)) > 0 AND published_at IS NOT NULL AND published_by IS NOT NULL
    )
  )
);
CREATE INDEX articles_search_idx ON articles USING gin (search_vector);
CREATE INDEX articles_title_trgm_idx ON articles USING gin (immutable_unaccent(lower(title)) gin_trgm_ops);
CREATE INDEX articles_status_vis_idx ON articles (status, visibility);
CREATE INDEX articles_category_idx ON articles (category_id);
CREATE INDEX articles_system_idx ON articles (system_id);
CREATE INDEX articles_updated_idx ON articles (updated_at DESC);

CREATE TABLE article_tags (
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  tag_id     uuid NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
  PRIMARY KEY (article_id, tag_id)
);
CREATE INDEX article_tags_tag_idx ON article_tags (tag_id);

-- Atualiza o vetor de pesquisa com pesos: título (A), palavras-chave/tags/resumo (B),
-- categoria/sistema (C), conteúdo (D).
CREATE OR REPLACE FUNCTION article_refresh_search_vector(p_article uuid) RETURNS void
  LANGUAGE sql AS $$
  UPDATE articles a SET search_vector =
      setweight(to_tsvector('pt_unaccent', coalesce(a.title, '')), 'A')
   || setweight(to_tsvector('pt_unaccent', array_to_string(a.keywords, ' ')), 'B')
   || setweight(to_tsvector('pt_unaccent', coalesce((
        SELECT string_agg(t.name, ' ') FROM article_tags at JOIN tags t ON t.id = at.tag_id WHERE at.article_id = a.id
      ), '')), 'B')
   || setweight(to_tsvector('pt_unaccent', coalesce(a.summary, '')), 'B')
   || setweight(to_tsvector('pt_unaccent', coalesce((SELECT c.name FROM categories c WHERE c.id = a.category_id), '')
        || ' ' || coalesce((SELECT s.name FROM systems s WHERE s.id = a.system_id), '')), 'C')
   || setweight(to_tsvector('pt_unaccent', coalesce(a.content_text, '')), 'D')
  WHERE a.id = p_article;
$$;

-- Versões (snapshot completo de cada versão do artigo).
CREATE TABLE article_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id    uuid NOT NULL REFERENCES articles(id) ON DELETE RESTRICT,
  version       integer NOT NULL,
  title         text NOT NULL,
  summary       text NOT NULL,
  content_html  text NOT NULL,
  content_text  text NOT NULL,
  category_id   uuid,
  system_id     uuid,
  keywords      text[] NOT NULL,
  tags          text[] NOT NULL,
  status        text NOT NULL,
  visibility    text NOT NULL,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (article_id, version)
);
CREATE TRIGGER article_versions_immutable BEFORE UPDATE OR DELETE ON article_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

-- Histórico de alterações (auditoria específica dos artigos).
CREATE TABLE article_history (
  id          bigserial PRIMARY KEY,
  article_id  uuid NOT NULL REFERENCES articles(id) ON DELETE RESTRICT,
  user_id     uuid NOT NULL REFERENCES users(id),
  operation   text NOT NULL,
  version     integer NOT NULL,
  changes     jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary     text,
  result      text NOT NULL DEFAULT 'success' CHECK (result IN ('success', 'failure')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX article_history_article_idx ON article_history (article_id, created_at DESC);
