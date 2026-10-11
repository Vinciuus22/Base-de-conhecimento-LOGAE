import { type Db, getPool } from '../db/pool.js';

const SENSITIVE_KEY_RE = /(pass(word)?|senha|token|secret|api[_-]?key|authorization|cookie|hash)/i;

/** Remove recursivamente campos sensíveis antes de registrar. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncado]';
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? '[removido]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 5000) return `${value.slice(0, 5000)}…`;
  return value;
}

export interface AuditEntry {
  actorId: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  data?: Record<string, unknown>;
  ip?: string | null;
}

export async function audit(entry: AuditEntry, db: Db = getPool()): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, data, ip) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.actorId,
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      JSON.stringify(redact(entry.data ?? {})),
      entry.ip ?? null,
    ],
  );
}
