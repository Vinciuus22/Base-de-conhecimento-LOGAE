import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config.js';

/**
 * Integração com o Claude (Anthropic API).
 *
 * - Requer ANTHROPIC_API_KEY. Sem a chave, o chat funciona em modo de
 *   recuperação (somente trechos da Base de Conhecimento, sem geração).
 * - Respostas estruturadas via output_config.format (JSON Schema).
 * - Fallback automático do servidor em caso de recusa (fallbacks: "default").
 */

export interface JsonRequest {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}

export type LlmProvider = (req: JsonRequest) => Promise<unknown>;

let override: LlmProvider | null = null;
/** Substitui o provedor (testes automatizados). */
export function setLlmProvider(fn: LlmProvider | null): void {
  override = fn;
}

export function llmEnabled(): boolean {
  return !!override || !!config().ANTHROPIC_API_KEY;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: config().ANTHROPIC_API_KEY, timeout: config().AI_TIMEOUT_MS, maxRetries: 2 });
  return client;
}

export class LlmRefusalError extends Error {}
export class LlmOutputError extends Error {}

export async function generateJson(req: JsonRequest): Promise<unknown> {
  if (override) return override(req);
  const cfg = config();
  if (!cfg.ANTHROPIC_API_KEY) throw new Error('IA generativa não configurada');

  const params = {
    model: cfg.AI_MODEL,
    max_tokens: req.maxTokens ?? 8000,
    system: req.system,
    messages: [{ role: 'user' as const, content: req.user }],
    thinking: { type: 'adaptive' as const },
    output_config: { effort: cfg.AI_EFFORT, format: { type: 'json_schema' as const, schema: req.schema } },
  };

  const response = cfg.AI_SERVER_FALLBACKS
    ? await getClient().beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    : await getClient().messages.create(params);

  if (response.stop_reason === 'refusal') throw new LlmRefusalError('A IA recusou a solicitação.');
  if (response.stop_reason === 'max_tokens') throw new LlmOutputError('Resposta da IA truncada.');
  const text = response.content
    .filter((b): b is Extract<(typeof response.content)[number], { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
  try {
    return JSON.parse(text);
  } catch {
    throw new LlmOutputError('Resposta da IA em formato inválido.');
  }
}
