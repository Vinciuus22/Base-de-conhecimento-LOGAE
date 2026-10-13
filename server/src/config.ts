import 'dotenv/config';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));
const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int().nonnegative());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: int(3000),
  PUBLIC_BASE_URL: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatória'),
  DATABASE_SSL: bool(false),
  APP_TIMEZONE: z.string().default('America/Sao_Paulo'),
  APP_NAME: z.string().default('Base de Conhecimento LOGAE'),
  /** Segredo para assinar URLs temporárias. Obrigatório em produção. */
  APP_SECRET: z.string().default('dev-only-secret-change-me-dev-only-secret'),
  SESSION_TTL_HOURS: int(12),
  COOKIE_SECURE: bool(false),
  TRUST_PROXY: bool(false),
  PUBLIC_ANONYMOUS_ACCESS: bool(true),

  // Bloqueio de edição
  LOCK_TTL_SECONDS: int(120),
  LOCK_HEARTBEAT_SECONDS: int(30),

  // Armazenamento
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool(false),
  SIGNED_URL_TTL_SECONDS: int(300),

  // Limites de upload (MB)
  MAX_IMAGE_MB: int(10),
  MAX_VIDEO_MB: int(200),
  MAX_ATTACHMENT_MB: int(25),
  MAX_DOCUMENT_MB: int(30),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  DOC_CONVERSION_ENABLED: bool(false),
  SOFFICE_PATH: z.string().default('soffice'),

  // Tickets
  TICKET_REOPEN_WINDOW_DAYS: int(7),

  // IA
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-opus-5-5'),
  AI_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),
  AI_SERVER_FALLBACKS: bool(true),
  AI_MAX_SOURCES: int(6),
  AI_TIMEOUT_MS: int(60000),
  VOYAGE_API_KEY: z.string().optional(),
  EMBEDDINGS_MODEL: z.string().default('voyage-3.5'),
  AI_CONVERSATION_RETENTION_DAYS: int(180),

  // Integração com o Jira (atualizações)
  JIRA_WEBHOOK_SECRET: z.string().optional(),
  JIRA_BASE_URL: z.string().optional(),
  JIRA_EMAIL: z.string().optional(),
  JIRA_API_TOKEN: z.string().optional(),
  JIRA_PROJECT_KEYS: z.string().optional(),
  /** Campo "release": id (customfield_12345), "fixVersions" ou o nome do campo. */
  JIRA_RELEASE_FIELD: z.string().default('fixVersions'),
  /** Campo "Público alvo": id (customfield_12345) ou nome do campo. */
  JIRA_AUDIENCE_FIELD: z.string().default('Público alvo'),
  JIRA_DONE_STATUSES: z.string().default('Done,Concluído,Concluida,Concluída,Finalizado,Resolvido'),
  JIRA_SYNC_MINUTES: int(0),
  /** Atualizações dos Cards: projetos monitorados (chaves separadas por vírgula). */
  JIRA_CARD_PROJECTS: z.string().default('CHL,RISK1'),
  /** Minutos entre sincronizações incrementais dos cards (0 = desativado). */
  JIRA_CARDS_SYNC_MINUTES: int(0),
  /** Contas compartilhadas (accountId, e-mail ou nome), separadas por vírgula. */
  JIRA_SHARED_ACCOUNTS: z.string().default(''),

  // Contas de teste (NÃO habilitar em produção)
  TEST_LOGINS_ENABLED: bool(false),

  // Rate limit
  RATE_LIMIT_LOGIN_PER_MIN: int(10),
  RATE_LIMIT_CHAT_PER_MIN: int(20),
  RATE_LIMIT_TICKETS_PER_HOUR: int(20),

  LOG_LEVEL: z.string().default('info'),
  SERVE_WEB: bool(true),
  WEB_DIST_DIR: z.string().default('../web/dist'),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuração inválida:\n${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production') {
    if (cfg.APP_SECRET.startsWith('dev-only') || cfg.APP_SECRET.length < 32) {
      throw new Error('APP_SECRET deve ser definido com pelo menos 32 caracteres em produção.');
    }
    if (cfg.STORAGE_DRIVER === 's3' && (!cfg.S3_BUCKET || !cfg.S3_REGION)) {
      throw new Error('S3_BUCKET e S3_REGION são obrigatórios quando STORAGE_DRIVER=s3.');
    }
  }
  return cfg;
}

let current: AppConfig | null = null;
export function config(): AppConfig {
  if (!current) current = loadConfig();
  return current;
}
export function setConfig(cfg: AppConfig): void {
  current = cfg;
}
