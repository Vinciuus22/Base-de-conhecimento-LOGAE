-- Comunicados voltam a ter visibilidade (Interno/Externo): o cadastro continua restrito a internos,
-- e os publicados como Externo ficam legíveis por clientes e visitantes.
ALTER TABLE announcements DROP CONSTRAINT IF EXISTS announcements_internal_only;
ALTER TABLE announcements ALTER COLUMN visibility SET DEFAULT 'internal';

-- Histórico de leitura por usuário ("Mais acessados por você").
CREATE TABLE article_reads (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  article_id   uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  read_count   integer NOT NULL DEFAULT 1,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, article_id)
);
CREATE INDEX article_reads_user_idx ON article_reads (user_id, read_count DESC, last_read_at DESC);
