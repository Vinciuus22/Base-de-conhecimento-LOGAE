-- Acesso de um usuário a várias empresas (além da principal) e sistemas contratados por empresa.
CREATE TABLE user_company_access (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, company_id)
);
CREATE INDEX user_company_access_company_idx ON user_company_access (company_id);

CREATE TABLE company_systems (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  system_id  uuid NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  PRIMARY KEY (company_id, system_id)
);
