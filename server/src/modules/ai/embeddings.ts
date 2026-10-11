import { config } from '../../config.js';
import { query } from '../../db/pool.js';

/**
 * Embeddings para pesquisa semântica (OPCIONAL).
 *
 * Provedor: Voyage AI (recomendado pela Anthropic para uso com o Claude).
 * Exige VOYAGE_API_KEY. Sem a chave, a pesquisa semântica fica desativada e o
 * sistema usa apenas a pesquisa textual (com stemming, sem acentos e sinônimos).
 */

export function embeddingsEnabled(): boolean {
  return !!config().VOYAGE_API_KEY;
}

export type EmbedFn = (texts: string[], inputType: 'document' | 'query') => Promise<number[][]>;

let embedOverride: EmbedFn | null = null;
/** Permite substituir o provedor (testes automatizados). */
export function setEmbeddingProvider(fn: EmbedFn | null): void {
  embedOverride = fn;
}

export async function embed(texts: string[], inputType: 'document' | 'query'): Promise<number[][]> {
  if (embedOverride) return embedOverride(texts, inputType);
  const cfg = config();
  if (!cfg.VOYAGE_API_KEY) throw new Error('Embeddings não configurados');
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.VOYAGE_API_KEY}` },
    body: JSON.stringify({ input: texts, model: cfg.EMBEDDINGS_MODEL, input_type: inputType }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Falha no provedor de embeddings (HTTP ${res.status})`);
  const json = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/** Agenda o cálculo dos embeddings pendentes (executado após o commit). */
export function scheduleEmbeddings(delayMs = 1000): void {
  if (!embeddingsEnabled() && !embedOverride) return;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void processPendingEmbeddings().catch((err) => console.error('[embeddings]', (err as Error).message));
  }, delayMs);
  timer.unref?.();
}

export async function processPendingEmbeddings(batchSize = 32): Promise<number> {
  if ((!embeddingsEnabled() && !embedOverride) || running) return 0;
  running = true;
  let total = 0;
  try {
    for (;;) {
      const rows = await query<{ id: string; heading: string | null; content: string }>(
        `SELECT id, heading, content FROM content_chunks WHERE embedding IS NULL AND available = true ORDER BY created_at LIMIT $1`,
        [batchSize],
      );
      if (!rows.length) break;
      const vectors = await embed(rows.map((r) => `${r.heading ?? ''}\n${r.content}`.trim()), 'document');
      for (let i = 0; i < rows.length; i++) {
        await query(`UPDATE content_chunks SET embedding = $2, embedding_model = $3 WHERE id = $1`, [
          rows[i]!.id,
          vectors[i],
          embedOverride ? 'test' : config().EMBEDDINGS_MODEL,
        ]);
      }
      total += rows.length;
      if (rows.length < batchSize) break;
    }
  } finally {
    running = false;
  }
  return total;
}
