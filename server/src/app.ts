import { existsSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { getPool } from './db/pool.js';
import authPlugin from './auth/plugin.js';
import { AppError } from './lib/errors.js';
import authRoutes from './modules/auth.routes.js';
import articleRoutes from './modules/articles/routes.js';
import fileRoutes from './modules/files.routes.js';
import taxonomyRoutes from './modules/taxonomy.routes.js';
import userRoutes from './modules/users.routes.js';
import ticketRoutes from './modules/tickets/routes.js';
import aiRoutes from './modules/ai/routes.js';
import documentRoutes from './modules/documents/routes.js';
import announcementRoutes from './modules/announcements.routes.js';
import auditRoutes from './modules/audit.routes.js';
import { embeddingsEnabled } from './modules/ai/embeddings.js';
import { llmEnabled } from './modules/ai/llm.js';

export async function buildApp(opts: FastifyServerOptions = {}): Promise<FastifyInstance> {
  const cfg = config();
  const app = Fastify({
    trustProxy: cfg.TRUST_PROXY,
    bodyLimit: 4 * 1024 * 1024,
    logger:
      opts.logger === false
        ? false
        : {
            level: cfg.LOG_LEVEL,
            // Nunca registrar cookies, tokens ou credenciais.
            redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'],
          },
    ...opts,
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // O editor e o conteúdo formatado usam estilos inline (cores, alinhamento, tamanho da fonte).
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https://i.ytimg.com'],
        mediaSrc: ["'self'", 'blob:'],
        frameSrc: ['https://www.youtube-nocookie.com'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: cfg.COOKIE_SECURE ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
  await app.register(rateLimit, { global: false });
  await app.register(multipart, {
    limits: {
      fileSize: Math.max(cfg.MAX_VIDEO_MB, cfg.MAX_DOCUMENT_MB, cfg.MAX_ATTACHMENT_MB, cfg.MAX_IMAGE_MB) * 1024 * 1024,
      files: 10,
      fields: 30,
      fieldSize: 100 * 1024,
    },
  });
  // sendBeacon envia text/plain.
  app.addContentTypeParser('text/plain', { parseAs: 'string', bodyLimit: 4096 }, (_req, body, done) => done(null, body));

  await app.register(authPlugin);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details ?? null } });
    }
    const e = err as { statusCode?: number; code?: string; message: string; validation?: unknown };
    if (e.statusCode === 429) {
      return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Muitas requisições. Aguarde um momento e tente novamente.' } });
    }
    if (e.code === 'FST_REQ_FILE_TOO_LARGE' || e.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || e.statusCode === 413) {
      return reply.code(413).send({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'O arquivo ou conteúdo enviado excede o tamanho máximo permitido.' } });
    }
    if (e.code === 'FST_FILES_LIMIT' || e.code === 'FST_PARTS_LIMIT') {
      return reply.code(413).send({ error: { code: 'TOO_MANY_FILES', message: 'Quantidade de arquivos acima do permitido.' } });
    }
    if (e.validation || (e.statusCode && e.statusCode >= 400 && e.statusCode < 500)) {
      return reply.code(e.statusCode ?? 400).send({ error: { code: e.code ?? 'BAD_REQUEST', message: 'Requisição inválida.' } });
    }
    req.log.error({ err }, 'Erro não tratado');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Ocorreu um erro inesperado. Tente novamente em instantes.' } });
  });

  // Configuração pública para o frontend (sem segredos).
  app.get('/api/config', async () => ({
    appName: cfg.APP_NAME,
    timezone: cfg.APP_TIMEZONE,
    anonymousAccess: cfg.PUBLIC_ANONYMOUS_ACCESS,
    lock: { ttlSeconds: cfg.LOCK_TTL_SECONDS, heartbeatSeconds: cfg.LOCK_HEARTBEAT_SECONDS },
    uploads: { maxImageMb: cfg.MAX_IMAGE_MB, maxVideoMb: cfg.MAX_VIDEO_MB, maxAttachmentMb: cfg.MAX_ATTACHMENT_MB, maxDocumentMb: cfg.MAX_DOCUMENT_MB },
    docConversion: cfg.DOC_CONVERSION_ENABLED,
    ai: { generative: llmEnabled(), semantic: embeddingsEnabled() },
    ticketReopenWindowDays: cfg.TICKET_REOPEN_WINDOW_DAYS,
  }));

  app.get('/api/health', async (_req, reply) => {
    try {
      await getPool().query('SELECT 1');
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'database_unavailable' });
    }
  });

  await app.register(authRoutes);
  await app.register(articleRoutes);
  await app.register(fileRoutes);
  await app.register(taxonomyRoutes);
  await app.register(userRoutes);
  await app.register(ticketRoutes);
  await app.register(aiRoutes);
  await app.register(documentRoutes);
  await app.register(announcementRoutes);
  await app.register(auditRoutes);

  // Frontend compilado (SPA) servido pelo próprio backend em produção.
  const webDir = path.resolve(cfg.WEB_DIST_DIR);
  if (cfg.SERVE_WEB && existsSync(path.join(webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false, index: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } });
      }
      const file = req.url.split('?')[0]!;
      if (file !== '/' && /\.[a-z0-9]+$/i.test(file)) {
        return reply.code(404).send('Not found');
      }
      reply.header('Cache-Control', 'no-cache');
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } }));
  }

  return app;
}
