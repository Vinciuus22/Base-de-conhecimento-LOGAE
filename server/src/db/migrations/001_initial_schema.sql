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
CREATE INDEX article_history_user_idx ON article_history (user_id);
CREATE TRIGGER article_history_immutable BEFORE UPDATE OR DELETE ON article_history
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

-- Bloqueio de edição: no máximo UM registro por artigo (chave primária).
-- A aquisição é atômica via INSERT ... ON CONFLICT ... WHERE expires_at <= now().
CREATE TABLE article_locks (
  article_id  uuid PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id  uuid REFERENCES sessions(id) ON DELETE SET NULL,
  lock_token  uuid NOT NULL UNIQUE,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  renewed_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX article_locks_expires_idx ON article_locks (expires_at);

-- ---------------------------------------------------------------------
-- Comunicados
-- ---------------------------------------------------------------------
CREATE TABLE announcements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text NOT NULL CHECK (length(trim(title)) > 0),
  content_html  text NOT NULL DEFAULT '',
  content_text  text NOT NULL DEFAULT '',
  category      text NOT NULL CHECK (category IN ('novidade', 'alteracao', 'manutencao', 'comunicado')),
  system_id     uuid REFERENCES systems(id) ON DELETE RESTRICT,
  visibility    text NOT NULL CHECK (visibility IN ('internal', 'external')),
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  author_id     uuid NOT NULL REFERENCES users(id),
  published_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('pt_unaccent', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('pt_unaccent', coalesce(content_text, '')), 'D')
  ) STORED
);
CREATE INDEX announcements_search_idx ON announcements USING gin (search_vector);
CREATE INDEX announcements_pub_idx ON announcements (status, visibility, published_at DESC);

CREATE TABLE announcement_articles (
  announcement_id uuid NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  article_id      uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  PRIMARY KEY (announcement_id, article_id)
);

-- ---------------------------------------------------------------------
-- Documentos importados
-- ---------------------------------------------------------------------
CREATE TABLE documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id         uuid NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  sha256          text NOT NULL,
  title           text NOT NULL CHECK (length(trim(title)) > 0),
  category_id     uuid REFERENCES categories(id) ON DELETE RESTRICT,
  system_id       uuid REFERENCES systems(id) ON DELETE RESTRICT,
  keywords        text[] NOT NULL DEFAULT '{}',
  visibility      text NOT NULL CHECK (visibility IN ('internal', 'external')),
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'processing', 'processed', 'processed_with_warnings', 'failed')),
  review_status   text NOT NULL DEFAULT 'pending_review' CHECK (review_status IN ('pending_review', 'approved', 'rejected')),
  extracted_text  text,
  page_count      integer,
  warnings        jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_message   text,
  attempts        integer NOT NULL DEFAULT 0,
  uploaded_by     uuid NOT NULL REFERENCES users(id),
  reviewed_by     uuid REFERENCES users(id),
  reviewed_at     timestamptz,
  processed_at    timestamptz,
  removed_at      timestamptz,
  removed_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- Evita duplicidade: o mesmo conteúdo não pode ser importado duas vezes (exceto se removido).
CREATE UNIQUE INDEX documents_sha_uq ON documents (sha256) WHERE removed_at IS NULL;

CREATE TABLE document_articles (
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  article_id  uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, article_id)
);

-- ---------------------------------------------------------------------
-- Trechos indexados para pesquisa e IA
-- Cada trecho mantém a origem, a visibilidade e se está liberado.
-- ---------------------------------------------------------------------
CREATE TABLE content_chunks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type   text NOT NULL CHECK (source_type IN ('article', 'document')),
  source_id     uuid NOT NULL,
  chunk_index   integer NOT NULL,
  heading       text,
  content       text NOT NULL,
  visibility    text NOT NULL CHECK (visibility IN ('internal', 'external')),
  available     boolean NOT NULL DEFAULT false,
  embedding     real[],
  embedding_model text,
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('pt_unaccent', coalesce(heading, '')), 'B') ||
    setweight(to_tsvector('pt_unaccent', content), 'D')
  ) STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_id, chunk_index)
);
CREATE INDEX content_chunks_search_idx ON content_chunks USING gin (search_vector);
CREATE INDEX content_chunks_source_idx ON content_chunks (source_type, source_id);
CREATE INDEX content_chunks_avail_idx ON content_chunks (available, visibility);

-- ---------------------------------------------------------------------
-- Conversas com IA
-- ---------------------------------------------------------------------
CREATE TABLE ai_conversations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  anon_token_hash   text,
  audience          text NOT NULL CHECK (audience IN ('internal', 'external')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_conversations_user_idx ON ai_conversations (user_id);

CREATE TABLE ai_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('user', 'assistant')),
  content          text NOT NULL,
  steps            jsonb NOT NULL DEFAULT '[]'::jsonb,
  found_solution   boolean,
  mode             text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_messages_conv_idx ON ai_messages (conversation_id, created_at);

CREATE TABLE ai_message_sources (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id   uuid NOT NULL REFERENCES ai_messages(id) ON DELETE CASCADE,
  source_type  text NOT NULL CHECK (source_type IN ('article', 'document')),
  source_id    uuid NOT NULL,
  chunk_id     uuid,
  title        text NOT NULL,
  url          text NOT NULL,
  excerpt      text NOT NULL
);
CREATE INDEX ai_message_sources_msg_idx ON ai_message_sources (message_id);

-- ---------------------------------------------------------------------
-- Tickets
-- ---------------------------------------------------------------------
CREATE SEQUENCE ticket_protocol_seq START 1;

CREATE TABLE tickets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  protocol        text NOT NULL UNIQUE,
  title           text NOT NULL CHECK (length(trim(title)) > 0),
  description     text NOT NULL CHECK (length(trim(description)) > 0),
  request_type    text NOT NULL CHECK (request_type IN ('incident', 'question', 'request', 'improvement')),
  category_id     uuid REFERENCES categories(id) ON DELETE RESTRICT,
  priority        text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  status          text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'triage', 'in_progress', 'waiting_user', 'waiting_technical', 'resolved', 'closed')),
  system_id       uuid NOT NULL REFERENCES systems(id) ON DELETE RESTRICT,
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  requester_id    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assignee_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  analysis_result text,
  procedures      text,
  solution        text,
  guidance        text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  closed_at       timestamptz,
  search_vector   tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('pt_unaccent', coalesce(protocol, '') || ' ' || coalesce(title, '')), 'A') ||
    setweight(to_tsvector('pt_unaccent', coalesce(description, '')), 'D')
  ) STORED
);
CREATE INDEX tickets_requester_idx ON tickets (requester_id, updated_at DESC);
CREATE INDEX tickets_company_idx ON tickets (company_id, updated_at DESC);
CREATE INDEX tickets_status_idx ON tickets (status);
CREATE INDEX tickets_assignee_idx ON tickets (assignee_id);
CREATE INDEX tickets_search_idx ON tickets USING gin (search_vector);

-- Mensagens públicas (visíveis ao cliente).
CREATE TABLE ticket_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   uuid NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
  author_id   uuid NOT NULL REFERENCES users(id),
  kind        text NOT NULL CHECK (kind IN ('customer_message', 'support_reply', 'info_request', 'solution')),
  body        text NOT NULL CHECK (length(trim(body)) > 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_messages_ticket_idx ON ticket_messages (ticket_id, created_at);
CREATE TRIGGER ticket_messages_immutable BEFORE UPDATE OR DELETE ON ticket_messages
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

-- Observações internas: tabela SEPARADA, nunca retornada ao cliente.
CREATE TABLE ticket_internal_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   uuid NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
  author_id   uuid NOT NULL REFERENCES users(id),
  body        text NOT NULL CHECK (length(trim(body)) > 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_notes_ticket_idx ON ticket_internal_notes (ticket_id, created_at);
CREATE TRIGGER ticket_notes_immutable BEFORE UPDATE OR DELETE ON ticket_internal_notes
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

-- Movimentações (status, atribuições, reaberturas, vínculos).
CREATE TABLE ticket_events (
  id          bigserial PRIMARY KEY,
  ticket_id   uuid NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
  actor_id    uuid REFERENCES users(id),
  type        text NOT NULL,
  from_status text,
  to_status   text,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Eventos internos (ex.: atribuição a atendente) podem ser ocultados do cliente.
  public      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_events_ticket_idx ON ticket_events (ticket_id, created_at);
CREATE TRIGGER ticket_events_immutable BEFORE UPDATE OR DELETE ON ticket_events
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

-- Anexos vinculados a mensagens específicas do ticket.
CREATE TABLE ticket_attachments (
  ticket_id   uuid NOT NULL REFERENCES tickets(id) ON DELETE RESTRICT,
  file_id     uuid NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  message_id  uuid REFERENCES ticket_messages(id),
  note_id     uuid REFERENCES ticket_internal_notes(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, file_id)
);

CREATE TABLE ticket_articles (
  ticket_id  uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  linked_by  uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, article_id)
);

-- ---------------------------------------------------------------------
-- Auditoria geral (imutável)
-- ---------------------------------------------------------------------
CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES users(id),
  action      text NOT NULL,
  entity_type text,
  entity_id   text,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);
CREATE INDEX audit_logs_action_idx ON audit_logs (action);
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
