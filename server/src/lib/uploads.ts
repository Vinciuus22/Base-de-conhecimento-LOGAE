import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, open, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MultipartFile } from '@fastify/multipart';
import { fileTypeFromFile } from 'file-type';
import sharp from 'sharp';
import { config } from '../config.js';
import { type Db, getPool, queryOne } from '../db/pool.js';
import { tooLarge, unsupported, validationError } from './errors.js';
import { storage } from './storage.js';
import { isImageMime, isVideoMime, type FileKind } from '@shared/uploads.js';

const execFileAsync = promisify(execFile);

export interface ReceivedFile {
  tmpDir: string;
  tmpPath: string;
  originalName: string;
  declaredMime: string;
  size: number;
  sha256: string;
}

export interface StoredFile {
  id: string;
  storage_key: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  kind: FileKind;
  width: number | null;
  height: number | null;
  thumbnail_id: string | null;
  owner_type: string | null;
  owner_id: string | null;
  parent_file_id: string | null;
  uploaded_by: string | null;
  created_at: Date;
}

export function sanitizeFilename(name: string): string {
  const base = path.basename(String(name || 'arquivo')).replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_').trim();
  return (base || 'arquivo').slice(0, 180);
}

/** Recebe um arquivo do multipart para um diretório temporário, calculando o hash. */
export async function receiveFile(part: MultipartFile): Promise<ReceivedFile> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'kb-upload-'));
  const tmpPath = path.join(tmpDir, 'upload.bin');
  const hash = createHash('sha256');
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(part.file as Readable, counter, createWriteStream(tmpPath, { mode: 0o600 }));
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true });
    throw err;
  }
  if (part.file.truncated) {
    await rm(tmpDir, { recursive: true, force: true });
    throw tooLarge(`O arquivo "${sanitizeFilename(part.filename)}" excede o tamanho máximo permitido.`);
  }
  if (size === 0) {
    await rm(tmpDir, { recursive: true, force: true });
    throw validationError(`O arquivo "${sanitizeFilename(part.filename)}" está vazio.`);
  }
  return {
    tmpDir,
    tmpPath,
    originalName: sanitizeFilename(part.filename),
    declaredMime: part.mimetype,
    size,
    sha256: hash.digest('hex'),
  };
}

export async function discard(file: ReceivedFile | null | undefined): Promise<void> {
  if (file) await rm(file.tmpDir, { recursive: true, force: true }).catch(() => undefined);
}

async function looksLikeUtf8Text(filePath: string): Promise<boolean> {
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const sample = buf.subarray(0, bytesRead);
    if (sample.includes(0)) return false;
    return !new TextDecoder('utf-8', { fatal: false }).decode(sample).includes('�');
  } finally {
    await fh.close();
  }
}

/**
 * Detecta o tipo REAL do arquivo pela assinatura (magic bytes), ignorando a
 * extensão e o tipo declarado pelo navegador. SVG e executáveis não são aceitos.
 */
export async function detectMime(file: ReceivedFile): Promise<string | null> {
  const ext = path.extname(file.originalName).toLowerCase();
  const detected = await fileTypeFromFile(file.tmpPath);
  if (detected) {
    if (detected.mime === 'application/x-cfb' && ext === '.doc') return 'application/msword';
    if (detected.mime === 'video/quicktime' || detected.mime === 'video/mp4' || detected.mime === 'video/webm') return detected.mime;
    if (detected.mime === 'video/x-m4v') return 'video/mp4';
    return detected.mime;
  }
  if ((ext === '.txt' || ext === '.csv') && (await looksLikeUtf8Text(file.tmpPath))) {
    return ext === '.csv' ? 'text/csv' : 'text/plain';
  }
  return null;
}

export function maxBytesFor(mime: string): number {
  const cfg = config();
  const mb = isImageMime(mime) ? cfg.MAX_IMAGE_MB : isVideoMime(mime) ? cfg.MAX_VIDEO_MB : cfg.MAX_ATTACHMENT_MB;
  return mb * 1024 * 1024;
}

export function kindFor(mime: string): FileKind {
  if (isImageMime(mime)) return 'image';
  if (isVideoMime(mime)) return 'video';
  return 'attachment';
}

/** Valida o tipo detectado contra a lista permitida e o limite de tamanho do tipo. */
export async function validateUpload(
  file: ReceivedFile,
  allowed: readonly string[],
  maxBytes?: number,
): Promise<string> {
  const mime = await detectMime(file);
  if (!mime || !allowed.includes(mime)) {
    throw unsupported(`Formato do arquivo "${file.originalName}" não permitido.`);
  }
  const limit = maxBytes ?? maxBytesFor(mime);
  if (file.size > limit) {
    throw tooLarge(`O arquivo "${file.originalName}" excede o limite de ${Math.round(limit / 1024 / 1024)} MB.`);
  }
  return mime;
}

function storageKeyFor(id: string): string {
  const d = new Date();
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${id}`;
}

async function generateVideoFrame(videoPath: string, outDir: string): Promise<string | null> {
  const out = path.join(outDir, 'frame.jpg');
  const ffmpeg = config().FFMPEG_PATH;
  for (const seek of ['00:00:01', '00:00:00']) {
    try {
      await execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', seek, '-i', videoPath, '-frames:v', '1', '-vf', 'scale=960:-2', out], {
        timeout: 30_000,
      });
      await readFile(out);
      return out;
    } catch {
      /* tenta o próximo ponto ou desiste */
    }
  }
  return null;
}

interface PersistOptions {
  mime: string;
  kind?: FileKind;
  ownerType?: string | null;
  ownerId?: string | null;
  uploadedBy: string | null;
  parentFileId?: string | null;
  generateThumbnail?: boolean;
}

/** Envia o arquivo ao armazenamento, registra os metadados e gera miniaturas quando aplicável. */
export async function persistFile(file: ReceivedFile, opts: PersistOptions, db: Db = getPool()): Promise<StoredFile & { thumbnailWarning?: string }> {
  const id = randomUUID();
  const key = storageKeyFor(id);
  const kind = opts.kind ?? kindFor(opts.mime);
  let width: number | null = null;
  let height: number | null = null;

  if (kind === 'image' || kind === 'thumbnail') {
    try {
      const meta = await sharp(file.tmpPath, { animated: false }).metadata();
      width = meta.width ?? null;
      height = meta.height ?? null;
    } catch {
      throw unsupported(`A imagem "${file.originalName}" não pôde ser lida (arquivo corrompido?).`);
    }
  }

  await storage().putFile(key, file.tmpPath, opts.mime);
  const row = (await queryOne<StoredFile>(
    `INSERT INTO files (id, storage_key, original_name, mime_type, size_bytes, sha256, kind, owner_type, owner_id, parent_file_id, width, height, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
    [id, key, file.originalName, opts.mime, file.size, file.sha256, kind, opts.ownerType ?? null, opts.ownerId ?? null, opts.parentFileId ?? null, width, height, opts.uploadedBy],
    db,
  ))!;

  let thumbnailWarning: string | undefined;
  if (opts.generateThumbnail !== false && (kind === 'image' || kind === 'video')) {
    try {
      let source: string | null = file.tmpPath;
      if (kind === 'video') source = await generateVideoFrame(file.tmpPath, file.tmpDir);
      if (source) {
        const thumb = await sharp(source, { animated: false }).rotate().resize({ width: 640, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
        const thumbId = randomUUID();
        const thumbKey = storageKeyFor(thumbId);
        await storage().putBuffer(thumbKey, thumb.data, 'image/webp');
        await db.query(
          `INSERT INTO files (id, storage_key, original_name, mime_type, size_bytes, sha256, kind, owner_type, owner_id, parent_file_id, width, height, uploaded_by)
           VALUES ($1, $2, $3, 'image/webp', $4, $5, 'thumbnail', $6, $7, $8, $9, $10, $11)`,
          [thumbId, thumbKey, `miniatura-${row.original_name}.webp`, thumb.data.length, createHash('sha256').update(thumb.data).digest('hex'), opts.ownerType ?? null, opts.ownerId ?? null, row.id, thumb.info.width, thumb.info.height, opts.uploadedBy],
        );
        await db.query(`UPDATE files SET thumbnail_id = $2 WHERE id = $1`, [row.id, thumbId]);
        row.thumbnail_id = thumbId;
      } else {
        thumbnailWarning = 'Não foi possível gerar a miniatura automaticamente. Envie uma imagem de capa.';
      }
    } catch {
      thumbnailWarning = 'Não foi possível gerar a miniatura automaticamente. Envie uma imagem de capa.';
    }
  }
  return { ...row, thumbnailWarning };
}

export function publicFile(f: StoredFile) {
  return {
    id: f.id,
    url: `/api/files/${f.id}`,
    name: f.original_name,
    mimeType: f.mime_type,
    size: Number(f.size_bytes),
    kind: f.kind,
    width: f.width,
    height: f.height,
    thumbnailUrl: f.thumbnail_id ? `/api/files/${f.thumbnail_id}` : null,
    thumbnailId: f.thumbnail_id,
    createdAt: f.created_at,
  };
}
