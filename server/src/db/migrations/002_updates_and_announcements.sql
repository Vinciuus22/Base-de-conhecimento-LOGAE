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
