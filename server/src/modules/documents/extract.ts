import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import { config } from '../../config.js';
import { sanitizeRichHtml } from '../../lib/sanitize.js';
import { extractHeadings, htmlToText } from '../../lib/text.js';

const execFileAsync = promisify(execFile);

export interface ExtractionResult {
  text: string;
  headings: string[];
  pageCount: number | null;
  warnings: string[];
}

export class ExtractionError extends Error {}

const MIN_CHARS_PER_PAGE = 80;

function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractPdf(data: Buffer): Promise<ExtractionResult> {
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(data));
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (/password/i.test(msg)) throw new ExtractionError('O PDF está protegido por senha e não pode ser processado.');
    throw new ExtractionError('O arquivo PDF está corrompido ou não pôde ser lido.');
  }
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = text.map((t) => normalizeText(t));
  const full = pages.filter(Boolean).join('\n\n');
  const warnings: string[] = [];
  const emptyPages = pages.filter((p) => p.length < 20).length;
  if (!full) {
    throw new ExtractionError(
      'Nenhum texto extraível foi encontrado. O documento parece ser digitalizado (imagem); o reconhecimento óptico de caracteres (OCR) não está disponível.',
    );
  }
  if (full.length / Math.max(totalPages, 1) < MIN_CHARS_PER_PAGE) {
    warnings.push('Pouco texto foi extraído em relação ao número de páginas. Parte do conteúdo pode estar em imagens (sem OCR).');
  }
  if (emptyPages > 0) warnings.push(`${emptyPages} página(s) sem texto extraível.`);
  return { text: full, headings: [], pageCount: totalPages, warnings };
}

async function extractDocx(data: Buffer): Promise<ExtractionResult> {
  let result;
  try {
    result = await mammoth.convertToHtml({ buffer: data });
  } catch {
    throw new ExtractionError('O arquivo DOCX está corrompido ou não pôde ser lido.');
  }
  const html = sanitizeRichHtml(result.value);
  const text = normalizeText(htmlToText(html));
  if (!text) throw new ExtractionError('O documento não contém texto extraível.');
  const warnings = result.messages
    .filter((m) => m.type === 'warning')
    .slice(0, 5)
    .map((m) => `Aviso na conversão: ${m.message}`);
  return { text, headings: extractHeadings(html), pageCount: null, warnings };
}

/** DOC (Word 97-2003): convertido para DOCX com LibreOffice em modo headless, quando habilitado. */
async function extractDoc(data: Buffer): Promise<ExtractionResult> {
  if (!config().DOC_CONVERSION_ENABLED) {
    throw new ExtractionError('A conversão de arquivos .doc não está habilitada neste servidor. Salve o arquivo como .docx ou PDF e importe novamente.');
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kb-doc-'));
  try {
    const input = path.join(dir, 'input.doc');
    await writeFile(input, data, { mode: 0o600 });
    try {
      await execFileAsync(
        config().SOFFICE_PATH,
        ['--headless', '--norestore', '--nolockcheck', `-env:UserInstallation=file://${dir}/profile`, '--convert-to', 'docx', '--outdir', dir, input],
        { timeout: 90_000 },
      );
    } catch {
      throw new ExtractionError('Falha ao converter o arquivo .doc. Salve-o como .docx ou PDF e importe novamente.');
    }
    const out = (await readdir(dir)).find((f) => f.endsWith('.docx'));
    if (!out) throw new ExtractionError('Falha ao converter o arquivo .doc.');
    const result = await extractDocx(await readFile(path.join(dir, out)));
    result.warnings.unshift('Arquivo .doc convertido automaticamente para .docx; revise a formatação extraída.');
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function extractDocumentText(data: Buffer, mime: string): Promise<ExtractionResult> {
  switch (mime) {
    case 'application/pdf':
      return extractPdf(data);
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return extractDocx(data);
    case 'application/msword':
      return extractDoc(data);
    default:
      throw new ExtractionError('Formato de documento não suportado.');
  }
}
