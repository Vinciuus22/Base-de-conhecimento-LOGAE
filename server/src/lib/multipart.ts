import type { FastifyRequest } from 'fastify';
import { badRequest, validationError } from './errors.js';
import { discard, receiveFile, type ReceivedFile } from './uploads.js';

export interface MultipartPayload {
  fields: Record<string, string>;
  files: ReceivedFile[];
  cleanup: () => Promise<void>;
}

/** Lê um formulário multipart (campos + arquivos em disco temporário). */
export async function readMultipart(req: FastifyRequest, opts: { maxFiles?: number; fileField?: string } = {}): Promise<MultipartPayload> {
  const maxFiles = opts.maxFiles ?? 10;
  const fields: Record<string, string> = {};
  const files: ReceivedFile[] = [];
  const cleanup = async () => {
    await Promise.all(files.map((f) => discard(f)));
  };
  if (!req.isMultipart()) {
    // Permite JSON quando não há arquivos.
    const body = (req.body ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(body)) if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') fields[k] = String(v);
    return { fields, files, cleanup };
  }
  try {
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (opts.fileField && part.fieldname !== opts.fileField) {
          part.file.resume();
          continue;
        }
        if (!part.filename) {
          part.file.resume();
          continue;
        }
        if (files.length >= maxFiles) {
          part.file.resume();
          throw validationError(`Envie no máximo ${maxFiles} arquivos por vez.`);
        }
        files.push(await receiveFile(part));
      } else {
        if (typeof part.value === 'string') fields[part.fieldname] = part.value.slice(0, 50_000);
      }
    }
  } catch (err) {
    await cleanup();
    if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw badRequest('Arquivo excede o tamanho máximo permitido.');
    throw err;
  }
  return { fields, files, cleanup };
}
