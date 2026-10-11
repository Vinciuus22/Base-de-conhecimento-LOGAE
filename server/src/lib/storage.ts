import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat, copyFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';

/**
 * Armazenamento de arquivos.
 *
 * - local: diretório PRIVADO no servidor (fora da pasta pública). Os arquivos
 *   só são entregues pela rota /api/files/:id, após verificação de permissão.
 * - s3: bucket privado compatível com S3 (AWS, MinIO, R2…). Os downloads usam
 *   URLs pré-assinadas temporárias, emitidas somente após a autorização.
 */
export interface StorageDriver {
  readonly name: 'local' | 's3';
  putFile(key: string, sourcePath: string, mimeType: string): Promise<void>;
  putBuffer(key: string, data: Buffer, mimeType: string): Promise<void>;
  /** Abre um stream de leitura (opcionalmente com intervalo de bytes). */
  read(key: string, range?: { start: number; end: number }): Promise<Readable>;
  size(key: string): Promise<number>;
  remove(key: string): Promise<void>;
  /** URL temporária assinada (somente drivers que suportam). */
  signedUrl?(key: string, opts: { filename: string; mimeType: string; inline: boolean }): Promise<string>;
}

function safeKey(key: string): string {
  if (!/^[a-z0-9][a-z0-9/_.-]{0,200}$/i.test(key) || key.includes('..')) throw new Error('Chave de armazenamento inválida');
  return key;
}

class LocalStorage implements StorageDriver {
  readonly name = 'local' as const;
  constructor(private readonly root: string) {}

  private fullPath(key: string): string {
    const full = path.resolve(this.root, safeKey(key));
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error('Caminho fora do armazenamento');
    return full;
  }

  async putFile(key: string, sourcePath: string): Promise<void> {
    const dest = this.fullPath(key);
    await mkdir(path.dirname(dest), { recursive: true, mode: 0o750 });
    await copyFile(sourcePath, dest);
  }

  async putBuffer(key: string, data: Buffer): Promise<void> {
    const dest = this.fullPath(key);
    await mkdir(path.dirname(dest), { recursive: true, mode: 0o750 });
    await pipeline(
      (async function* () {
        yield data;
      })(),
      createWriteStream(dest, { mode: 0o640 }),
    );
  }

  async read(key: string, range?: { start: number; end: number }): Promise<Readable> {
    return createReadStream(this.fullPath(key), range ? { start: range.start, end: range.end } : undefined);
  }

  async size(key: string): Promise<number> {
    return (await stat(this.fullPath(key))).size;
  }

  async remove(key: string): Promise<void> {
    await rm(this.fullPath(key), { force: true });
  }
}

class S3Storage implements StorageDriver {
  readonly name = 's3' as const;
  private clientPromise: Promise<import('@aws-sdk/client-s3').S3Client> | null = null;

  private async client() {
    if (!this.clientPromise) {
      this.clientPromise = import('@aws-sdk/client-s3').then(({ S3Client }) => {
        const cfg = config();
        return new S3Client({
          region: cfg.S3_REGION,
          endpoint: cfg.S3_ENDPOINT || undefined,
          forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
          credentials:
            cfg.S3_ACCESS_KEY_ID && cfg.S3_SECRET_ACCESS_KEY
              ? { accessKeyId: cfg.S3_ACCESS_KEY_ID, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY }
              : undefined,
        });
      });
    }
    return this.clientPromise;
  }

  private get bucket(): string {
    return config().S3_BUCKET!;
  }

  async putFile(key: string, sourcePath: string, mimeType: string): Promise<void> {
    const { Upload } = await import('@aws-sdk/lib-storage');
    const upload = new Upload({
      client: await this.client(),
      params: { Bucket: this.bucket, Key: safeKey(key), Body: createReadStream(sourcePath), ContentType: mimeType },
    });
    await upload.done();
  }

  async putBuffer(key: string, data: Buffer, mimeType: string): Promise<void> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await (await this.client()).send(
      new PutObjectCommand({ Bucket: this.bucket, Key: safeKey(key), Body: data, ContentType: mimeType }),
    );
  }

  async read(key: string, range?: { start: number; end: number }): Promise<Readable> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const res = await (await this.client()).send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: safeKey(key),
        Range: range ? `bytes=${range.start}-${range.end}` : undefined,
      }),
    );
    return res.Body as Readable;
  }

  async size(key: string): Promise<number> {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const res = await (await this.client()).send(new HeadObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }));
    return Number(res.ContentLength ?? 0);
  }

  async remove(key: string): Promise<void> {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    await (await this.client()).send(new DeleteObjectCommand({ Bucket: this.bucket, Key: safeKey(key) }));
  }

  async signedUrl(key: string, opts: { filename: string; mimeType: string; inline: boolean }): Promise<string> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const disposition = `${opts.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(opts.filename)}`;
    return getSignedUrl(
      await this.client(),
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: safeKey(key),
        ResponseContentDisposition: disposition,
        ResponseContentType: opts.mimeType,
      }),
      { expiresIn: config().SIGNED_URL_TTL_SECONDS },
    );
  }
}

let driver: StorageDriver | null = null;

export function storage(): StorageDriver {
  if (!driver) {
    const cfg = config();
    driver = cfg.STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalStorage(path.resolve(cfg.STORAGE_LOCAL_DIR));
  }
  return driver;
}

export function resetStorage(): void {
  driver = null;
}
