import { config } from './config.js';
import { query } from './db/pool.js';
import { purgeExpiredLocks } from './modules/articles/locks.js';
import { processPendingEmbeddings } from './modules/ai/embeddings.js';
import { jiraConfigured, syncFromJira } from './modules/updates/jira.js';
import { syncCards } from './modules/cards/service.js';
import { resumePendingDocuments } from './modules/documents/service.js';

/** Tarefas periódicas de manutenção (bloqueios expirados, sessões, retenção de dados). */
export function startJobs(log: (msg: string, err?: unknown) => void): () => void {
  const timers: NodeJS.Timeout[] = [];
  const safe = (name: string, fn: () => Promise<unknown>) => () => {
    fn().catch((err) => log(`Falha na tarefa ${name}`, err));
  };

  // A cada 30s: libera bloqueios de edição cujo lease expirou (com registro de auditoria).
  timers.push(setInterval(safe('locks', purgeExpiredLocks), 30_000));

  // A cada 10 min: sessões expiradas e embeddings pendentes.
  timers.push(
    setInterval(
      safe('sessions', async () => {
        await query(`DELETE FROM sessions WHERE expires_at < now()`);
        await processPendingEmbeddings();
      }),
      10 * 60_000,
    ),
  );

  // A cada 6h: retenção de conversas com IA (LGPD — minimização de dados).
  timers.push(
    setInterval(
      safe('retention', async () => {
        await query(`DELETE FROM ai_conversations WHERE updated_at < now() - make_interval(days => $1)`, [config().AI_CONVERSATION_RETENTION_DAYS]);
      }),
      6 * 3600_000,
    ),
  );

  // Sincronização periódica opcional com o Jira (complementa o webhook).
  const syncMinutes = config().JIRA_SYNC_MINUTES;
  if (syncMinutes > 0 && jiraConfigured()) {
    timers.push(setInterval(safe('jira-sync', () => syncFromJira(syncMinutes * 2)), syncMinutes * 60_000));
  }

  // Sincronização periódica dos cards (complementa o webhook; incremental e idempotente).
  const cardMinutes = config().JIRA_CARDS_SYNC_MINUTES;
  if (cardMinutes > 0 && jiraConfigured()) {
    timers.push(setInterval(safe('jira-cards', () => syncCards().catch((e) => { if (e?.code !== 'SYNC_RUNNING') throw e; })), cardMinutes * 60_000));
  }

  void safe('resume-documents', resumePendingDocuments)();
  void safe('embeddings', processPendingEmbeddings)();
  for (const t of timers) t.unref();
  return () => timers.forEach((t) => clearInterval(t));
}
