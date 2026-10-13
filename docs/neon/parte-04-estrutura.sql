
-- Histórico de leitura por usuário ("Mais acessados por você").
CREATE TABLE article_reads (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  article_id   uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  read_count   integer NOT NULL DEFAULT 1,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, article_id)
);
CREATE INDEX article_reads_user_idx ON article_reads (user_id, read_count DESC, last_read_at DESC);

-- Documentos de apoio do suporte (requisições, documentação de API, manuais, planilhas): arquivo OU link externo.
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_owner_type_check;
ALTER TABLE files ADD CONSTRAINT files_owner_type_check
  CHECK (owner_type IN ('article', 'announcement', 'ticket', 'ticket_note', 'document', 'support_document'));

CREATE TABLE support_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL CHECK (length(trim(title)) > 0),
  doc_type    text NOT NULL CHECK (doc_type IN ('requisicao', 'api', 'pdf', 'planilha', 'outro')),
  system_id   uuid NOT NULL REFERENCES systems(id),
  visibility  text NOT NULL CHECK (visibility IN ('internal', 'external')),
  description text,
  external_url text,
  file_id     uuid REFERENCES files(id),
  author_id   uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  deleted_by  uuid REFERENCES users(id),
  CHECK (file_id IS NOT NULL OR external_url IS NOT NULL)
);
CREATE INDEX support_documents_idx ON support_documents (created_at DESC) WHERE deleted_at IS NULL;

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

