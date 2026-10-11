import os from 'node:os';
import path from 'node:path';

// Ambiente isolado para os testes (banco kb_test e armazenamento temporário).
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://kb:kb@localhost:5432/kb_test';
process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_LOCAL_DIR = path.join(os.tmpdir(), 'kb-test-storage');
process.env.LOG_LEVEL = 'silent';
process.env.ANTHROPIC_API_KEY = '';
process.env.VOYAGE_API_KEY = '';
process.env.PUBLIC_ANONYMOUS_ACCESS = 'true';
process.env.RATE_LIMIT_LOGIN_PER_MIN = '10000';
process.env.RATE_LIMIT_CHAT_PER_MIN = '10000';
process.env.RATE_LIMIT_TICKETS_PER_HOUR = '10000';
process.env.LOCK_TTL_SECONDS = '120';
process.env.SERVE_WEB = 'false';
process.env.PUBLIC_BASE_URL = 'http://localhost:5173';

// Integração com o Jira (testes usam um segredo e campos fictícios)
process.env.JIRA_WEBHOOK_SECRET = 'segredo-de-teste-do-jira';
process.env.JIRA_BASE_URL = 'https://exemplo.atlassian.net';
process.env.JIRA_EMAIL = 'jira@teste.com';
process.env.JIRA_API_TOKEN = 'token-de-teste';
process.env.JIRA_RELEASE_FIELD = 'customfield_10050';
process.env.JIRA_AUDIENCE_FIELD = 'Público alvo';
process.env.TEST_LOGINS_ENABLED = 'true';
