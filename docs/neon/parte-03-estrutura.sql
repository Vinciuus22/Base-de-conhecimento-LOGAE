
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

-- =====================================================================
-- Atualizações (integradas ao Jira) e comunicados internos
-- =====================================================================

-- Atualizações: alimentadas pelo Jira quando uma tarefa é concluída e o
-- campo "release" está preenchido. visibility segue o campo "Público alvo":
-- 'external' = clientes e internos (inclui "ambos"); 'internal' = só internos.
CREATE TABLE updates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jira_key         text NOT NULL UNIQUE,
  jira_url         text,
  title            text NOT NULL CHECK (length(trim(title)) > 0),
  description_text text NOT NULL DEFAULT '',
  release          text NOT NULL CHECK (length(trim(release)) > 0),
  audience_raw     text,
  visibility       text NOT NULL CHECK (visibility IN ('internal', 'external')),
  system_id        uuid REFERENCES systems(id) ON DELETE SET NULL,
  jira_status      text,
  completed_at     timestamptz,
  status           text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden')),
  -- Quando um usuário interno altera visibilidade/situação manualmente, o Jira não sobrescreve.
  manual_override  boolean NOT NULL DEFAULT false,
  published_at     timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  search_vector    tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('pt_unaccent', coalesce(jira_key, '') || ' ' || coalesce(title, '') || ' ' || coalesce(release, '')), 'A') ||
    setweight(to_tsvector('pt_unaccent', coalesce(description_text, '')), 'D')
  ) STORED
);
CREATE INDEX updates_list_idx ON updates (status, visibility, completed_at DESC);
CREATE INDEX updates_system_idx ON updates (system_id);
CREATE INDEX updates_search_idx ON updates USING gin (search_vector);

-- Comunicados passam a ser exclusivos de usuários internos e podem ser
-- vinculados a várias plataformas (sistemas).
UPDATE announcements SET visibility = 'internal';
ALTER TABLE announcements ADD CONSTRAINT announcements_internal_only CHECK (visibility = 'internal');

CREATE TABLE announcement_systems (
  announcement_id uuid NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  system_id       uuid NOT NULL REFERENCES systems(id) ON DELETE RESTRICT,
  PRIMARY KEY (announcement_id, system_id)
);
INSERT INTO announcement_systems (announcement_id, system_id)
  SELECT id, system_id FROM announcements WHERE system_id IS NOT NULL ON CONFLICT DO NOTHING;

-- Atualizações dos Cards: espelho local (somente leitura) dos cards do Jira e seu histórico.

CREATE TABLE jira_cards (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  jira_id            text NOT NULL UNIQUE,
  card_key           text NOT NULL UNIQUE,
  project_key        text NOT NULL,
  project_name       text,
  board_name         text,
  title              text NOT NULL,
  description        text NOT NULL DEFAULT '',
  status             text,
  status_category    text,
  priority           text,
  issue_type         text,
  assignee_name      text,
  assignee_account_id text,
  reporter_name      text,
  jira_created_at    timestamptz,
  jira_updated_at    timestamptz,
  url                text,
  last_event_type    text,
  last_event_author  text,
  last_event_at      timestamptz,
  last_synced_at     timestamptz NOT NULL DEFAULT now(),
  -- false quando changelog/comentários não puderam ser recuperados por completo
  history_complete   boolean NOT NULL DEFAULT false,
  history_note       text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jira_cards_project_idx ON jira_cards (project_key);
CREATE INDEX jira_cards_status_idx ON jira_cards (status);
CREATE INDEX jira_cards_updated_idx ON jira_cards (jira_updated_at DESC NULLS LAST);
CREATE INDEX jira_cards_assignee_idx ON jira_cards (assignee_name);
CREATE INDEX jira_cards_title_trgm ON jira_cards USING gin (title gin_trgm_ops);

CREATE TABLE jira_card_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id           uuid NOT NULL REFERENCES jira_cards(id) ON DELETE CASCADE,
  -- chave natural do evento (ex.: "cl:10042:status", "cm:556"); impede duplicidade
  event_key         text NOT NULL,
  jira_event_id     text,
  event_type        text NOT NULL,
  field_name        text,
  from_value        text,
  to_value          text,
  comment_text      text,
  comment_restricted boolean NOT NULL DEFAULT false,
  author_name       text,
  author_account_id text,
  occurred_at       timestamptz NOT NULL,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  summary           text NOT NULL,
  source            text NOT NULL DEFAULT 'sync',
  UNIQUE (card_id, event_key)
);
CREATE INDEX jira_card_events_card_idx ON jira_card_events (card_id, occurred_at DESC);
CREATE INDEX jira_card_events_author_idx ON jira_card_events (author_name);
CREATE INDEX jira_card_events_type_idx ON jira_card_events (event_type);
CREATE INDEX jira_card_events_time_idx ON jira_card_events (occurred_at DESC);

-- Execuções de sincronização (diagnóstico e recuperação)
CREATE TABLE jira_sync_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL,                 -- full | incremental | webhook
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text NOT NULL DEFAULT 'running', -- running | success | partial | failed
  cards_seen   integer NOT NULL DEFAULT 0,
  events_added integer NOT NULL DEFAULT 0,
  error        text,
  triggered_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX jira_sync_runs_started_idx ON jira_sync_runs (started_at DESC);

-- Webhooks recebidos (deduplicação e rastreabilidade)
CREATE TABLE jira_webhook_events (
  delivery_key text PRIMARY KEY,
  received_at  timestamptz NOT NULL DEFAULT now(),
  webhook_event text,
  card_key     text,
  status       text NOT NULL DEFAULT 'received', -- received | processed | ignored | failed
  error        text
);
CREATE INDEX jira_webhook_events_received_idx ON jira_webhook_events (received_at DESC);

-- Integração de Clientes: cards de integração, atividades de acompanhamento e histórico de alterações.

CREATE TABLE integration_activity_types (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(trim(name)) > 0),
  active     boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100
);
CREATE UNIQUE INDEX integration_activity_types_name_uq ON integration_activity_types (lower(name));
INSERT INTO integration_activity_types (name, sort_order) VALUES
  ('Reunião', 10), ('Contato com o cliente', 20), ('Atividade técnica', 30), ('Configuração de sistema', 40),
  ('Teste de integração', 50), ('Validação de dados', 60), ('Pendência identificada', 70), ('Ação executada', 80),
  ('Decisão tomada', 90), ('Próxima etapa', 100), ('Observação', 110);

CREATE TABLE customer_integrations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id),
  system_id        uuid NOT NULL REFERENCES systems(id),          -- TMS
  objective        text NOT NULL CHECK (length(trim(objective)) > 0),
  description      text NOT NULL CHECK (length(trim(description)) > 0),
  cs_gc_id         uuid NOT NULL REFERENCES users(id),
  operator_id      uuid REFERENCES users(id),
  status           text NOT NULL DEFAULT 'inicio' CHECK (status IN ('inicio', 'acompanhamento', 'finalizado')),
  started_on       date,
  expected_end_on  date,
  finished_on      date,
  next_action      text,
  next_action_owner_id uuid REFERENCES users(id),
  next_action_due  date,
  next_action_notes text,
  notes            text,
  -- dados da finalização (preservados mesmo após reabertura, no histórico de alterações)
  result_summary   text,
  final_notes      text,
  remaining_pending text,
  finished_by      uuid REFERENCES users(id),
  archived_at      timestamptz,
  archived_by      uuid REFERENCES users(id),
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1,
  -- evita duplicidade acidental por reenvio do formulário
  create_token     uuid UNIQUE
);
CREATE INDEX customer_integrations_status_idx ON customer_integrations (status);
CREATE INDEX customer_integrations_company_idx ON customer_integrations (company_id);
CREATE INDEX customer_integrations_system_idx ON customer_integrations (system_id);
CREATE INDEX customer_integrations_cs_idx ON customer_integrations (cs_gc_id);
CREATE INDEX customer_integrations_operator_idx ON customer_integrations (operator_id);
CREATE INDEX customer_integrations_updated_idx ON customer_integrations (updated_at DESC);
CREATE INDEX customer_integrations_next_due_idx ON customer_integrations (next_action_due) WHERE next_action_due IS NOT NULL;

CREATE TABLE integration_activities (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL REFERENCES customer_integrations(id) ON DELETE RESTRICT,
  type_id        uuid NOT NULL REFERENCES integration_activity_types(id),
  type_name      text NOT NULL,
  description    text NOT NULL CHECK (length(trim(description)) > 0),
  outcome        text,
  next_action    text,
  next_action_due date,
  author_id      uuid NOT NULL REFERENCES users(id),
  author_name    text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  edited_at      timestamptz,
  deleted_at     timestamptz,      -- remoção lógica (somente administradores; registrada no histórico)
  deleted_by     uuid REFERENCES users(id)
);
CREATE INDEX integration_activities_idx ON integration_activities (integration_id, created_at DESC);

-- Histórico de alterações: imutável.
CREATE TABLE integration_changes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL REFERENCES customer_integrations(id) ON DELETE RESTRICT,
  operation_id   uuid NOT NULL,
  operation_type text NOT NULL,   -- create | update | status_change | finish | reopen | archive | restore | activity_edit | activity_delete
  user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  user_name      text NOT NULL,
  field_name     text NOT NULL,
  old_value      text,
  new_value      text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX integration_changes_idx ON integration_changes (integration_id, created_at DESC);
CREATE INDEX integration_changes_op_idx ON integration_changes (operation_id);
CREATE TRIGGER integration_changes_immutable BEFORE UPDATE OR DELETE ON integration_changes
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

-- Comunicados voltam a ter visibilidade (Interno/Externo): o cadastro continua restrito a internos,
-- e os publicados como Externo ficam legíveis por clientes e visitantes.
ALTER TABLE announcements DROP CONSTRAINT IF EXISTS announcements_internal_only;
ALTER TABLE announcements ALTER COLUMN visibility SET DEFAULT 'internal';
