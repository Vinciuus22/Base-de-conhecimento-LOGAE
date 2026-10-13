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
