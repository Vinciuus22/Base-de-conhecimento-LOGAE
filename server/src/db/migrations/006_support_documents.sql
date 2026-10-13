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
