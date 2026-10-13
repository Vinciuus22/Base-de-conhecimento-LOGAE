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
