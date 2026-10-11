import { z, type ZodTypeAny } from 'zod';
import { validationError } from './errors.js';

/** Valida a entrada com zod e lança erro 422 com as mensagens por campo. */
export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const fields: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join('.') || '_';
      if (!fields[key]) fields[key] = issue.message;
    }
    const first = Object.values(fields)[0] ?? 'Dados inválidos.';
    throw validationError(first, { fields });
  }
  return result.data;
}

export const uuid = z.string().uuid('Identificador inválido.');
export const optionalUuid = z
  .union([z.string().uuid('Identificador inválido.'), z.literal(''), z.null()])
  .optional()
  .transform((v) => (v ? v : null));

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export function dateRange(from?: string, to?: string): { from: Date | null; to: Date | null } {
  const f = from ? new Date(from) : null;
  const t = to ? new Date(to) : null;
  return {
    from: f && !Number.isNaN(f.getTime()) ? f : null,
    // "até" inclusivo: final do dia informado (quando apenas a data for enviada).
    to: t && !Number.isNaN(t.getTime()) ? (to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? new Date(t.getTime() + 86_399_999) : t) : null,
  };
}
