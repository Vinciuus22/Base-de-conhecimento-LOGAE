import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import JSZip from 'jszip';
import sharp from 'sharp';
import type { PermissionKey, RoleKey } from '@shared/permissions.js';
import { buildApp } from '../src/app.js';
import { query, queryOne } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/crypto.js';

export const PASSWORD = 'Senha12345!';

let appPromise: Promise<FastifyInstance> | null = null;
export function getApp(): Promise<FastifyInstance> {
  appPromise ??= buildApp({ logger: false }).then(async (app) => {
    await app.ready();
    return app;
  });
  return appPromise;
}

export function uid(prefix = 'x'): string {
  return `${prefix}${randomUUID().slice(0, 8)}`;
}

export async function createCompany(name = uid('Empresa ')): Promise<string> {
  return (await queryOne<{ id: string }>(`INSERT INTO companies (name) VALUES ($1) RETURNING id`, [name]))!.id;
}

export async function createSystem(name = uid('Sistema ')): Promise<string> {
  return (await queryOne<{ id: string }>(`INSERT INTO systems (name, slug) VALUES ($1, $2) RETURNING id`, [name, name.toLowerCase().replace(/\W+/g, '-')]))!.id;
}

export async function createCategory(name = uid('Categoria ')): Promise<string> {
  return (await queryOne<{ id: string }>(`INSERT INTO categories (name, slug) VALUES ($1, $2) RETURNING id`, [name, name.toLowerCase().replace(/\W+/g, '-')]))!.id;
}

let cachedHash: string | null = null;
export async function createUser(opts: {
  type?: 'internal' | 'external';
  roles?: RoleKey[];
  grant?: PermissionKey[];
  deny?: PermissionKey[];
  companyId?: string | null;
  name?: string;
}): Promise<{ id: string; email: string; name: string }> {
  cachedHash ??= await hashPassword(PASSWORD);
  const type = opts.type ?? 'internal';
  const email = `${uid('u')}@teste.com`;
  const name = opts.name ?? uid('Usuário ');
  const companyId = opts.companyId === undefined ? (type === 'external' ? await createCompany() : null) : opts.companyId;
  const u = await queryOne<{ id: string }>(
    `INSERT INTO users (name, email, password_hash, user_type, company_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [name, email, cachedHash, type, companyId],
  );
  for (const r of opts.roles ?? (type === 'external' ? ['external'] : [])) {
    await query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = $2`, [u!.id, r]);
  }
  for (const p of opts.grant ?? []) await query(`INSERT INTO user_permissions (user_id, permission_key, effect) VALUES ($1, $2, 'grant')`, [u!.id, p]);
  for (const p of opts.deny ?? []) await query(`INSERT INTO user_permissions (user_id, permission_key, effect) VALUES ($1, $2, 'deny')`, [u!.id, p]);
  return { id: u!.id, email, name };
}

export interface Session {
  userId: string;
  name: string;
  cookie: string;
  csrf: string;
  request: (method: string, url: string, body?: unknown, headers?: Record<string, string>) => Promise<LightMyRequestResponse>;
  multipart: (method: string, url: string, form: MultipartForm) => Promise<LightMyRequestResponse>;
}

export interface MultipartForm {
  fields?: Record<string, string>;
  files?: Array<{ field?: string; filename: string; content: Buffer; contentType?: string }>;
}

export function buildMultipart(form: MultipartForm): { body: Buffer; contentType: string } {
  const boundary = `----kbtest${randomUUID().replace(/-/g, '')}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(form.fields ?? {})) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const f of form.files ?? []) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.field ?? 'files'}"; filename="${f.filename}"\r\nContent-Type: ${f.contentType ?? 'application/octet-stream'}\r\n\r\n`,
      ),
      f.content,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function makeSession(app: FastifyInstance, userId: string, name: string, cookie: string, csrf: string): Session {
  const headers = () => (cookie ? { cookie, 'x-csrf-token': csrf } : {});
  return {
    userId,
    name,
    cookie,
    csrf,
    request: (method, url, body, extra) =>
      app.inject({ method: method as 'GET', url, payload: body as object | undefined, headers: { ...headers(), ...(extra ?? {}) } }),
    multipart: (method, url, form) => {
      const mp = buildMultipart(form);
      return app.inject({ method: method as 'POST', url, payload: mp.body, headers: { ...headers(), 'content-type': mp.contentType } });
    },
  };
}

export async function login(user: { id: string; email: string; name: string }): Promise<Session> {
  const app = await getApp();
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password: PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`Falha no login: ${res.body}`);
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  const cookie = raw.split(';')[0]!;
  return makeSession(app, user.id, user.name, cookie, res.json().csrfToken);
}

export async function anonymous(): Promise<Session> {
  const app = await getApp();
  return makeSession(app, '', 'anônimo', '', '');
}

export async function loginAs(opts: Parameters<typeof createUser>[0]): Promise<Session> {
  return login(await createUser(opts));
}

// ---------------------------------------------------------------------------
// Arquivos de teste
// ---------------------------------------------------------------------------
export async function pngBuffer(width = 64, height = 48): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } } }).png().toBuffer();
}

export async function gifBuffer(): Promise<Buffer> {
  return sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 200, g: 20, b: 20 } } }).gif().toBuffer();
}

let mp4Cache: Buffer | null = null;
export function mp4Buffer(): Buffer {
  if (mp4Cache) return mp4Cache;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kb-mp4-'));
  const out = path.join(dir, 'video.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10', '-pix_fmt', 'yuv420p', '-y', out]);
  mp4Cache = readFileSync(out);
  return mp4Cache;
}

/** PDF mínimo válido com uma página de texto (ou sem texto, para simular documento digitalizado). */
export function pdfBuffer(lines: string[] | null): Buffer {
  const stream = lines
    ? `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((l) => `(${l.replace(/[()\\]/g, '')}) Tj T*`).join(' ')} ET`
    : '0 0 1 rg 72 72 100 100 re f';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** DOCX mínimo válido com título e parágrafos. */
export async function docxBuffer(heading: string, paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${esc(heading)}</w:t></w:r></w:p>` +
      paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`).join('') +
      `</w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** Cria um artigo diretamente via API (rascunho) e opcionalmente publica. */
export async function createArticleVia(
  s: Session,
  data: Partial<{ title: string; summary: string; contentHtml: string; categoryId: string; systemId: string; keywords: string[]; visibility: 'internal' | 'external'; tags: string[] }>,
): Promise<{ id: string; slug: string; version: number }> {
  const res = await s.request('POST', '/api/articles', {
    title: data.title ?? uid('Artigo '),
    summary: data.summary ?? 'Resumo do artigo de teste.',
    contentHtml: data.contentHtml ?? '<p>Conteúdo do artigo de teste.</p>',
    categoryId: data.categoryId ?? (await createCategory()),
    systemId: data.systemId ?? (await createSystem()),
    keywords: data.keywords ?? ['teste'],
    visibility: data.visibility ?? 'external',
    tags: data.tags ?? [],
  });
  if (res.statusCode !== 201) throw new Error(`Falha ao criar artigo: ${res.body}`);
  const a = res.json().article;
  return { id: a.id, slug: a.slug, version: a.version };
}

export async function publishVia(s: Session, id: string): Promise<number> {
  const current = await queryOne<{ version: number }>(`SELECT version FROM articles WHERE id = $1`, [id]);
  const res = await s.request('POST', `/api/articles/${id}/publish`, { expectedVersion: current!.version });
  if (res.statusCode !== 200) throw new Error(`Falha ao publicar: ${res.body}`);
  return res.json().article.version;
}
