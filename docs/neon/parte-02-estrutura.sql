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
