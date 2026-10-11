/** Utilitários de texto. */

export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export function slugify(text: string, maxLength = 80): string {
  const slug = normalize(text)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || 'item';
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

/** Converte HTML (já sanitizado) em texto puro, preservando quebras de bloco. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|pre|blockquote|figure|figcaption|table|ul|ol)>/gi, '\n')
    .replace(/<(td|th)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z0-9]+);/gi, (m, e: string) => {
      const lower = e.toLowerCase();
      if (ENTITIES[lower] !== undefined) return ENTITIES[lower]!;
      if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
      if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
      return m;
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Converte texto puro em parágrafos HTML (usado ao gerar artigos a partir de documentos). */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export interface Chunk {
  heading: string | null;
  content: string;
}

/**
 * Divide o conteúdo em trechos de tamanho controlado, respeitando parágrafos
 * e mantendo o título da seção mais próxima como contexto.
 */
export function chunkText(text: string, opts: { maxChars?: number; overlap?: number; headings?: string[] } = {}): Chunk[] {
  const maxChars = opts.maxChars ?? 1200;
  const overlap = opts.overlap ?? 150;
  const headings = new Set((opts.headings ?? []).map((h) => h.trim()).filter(Boolean));
  const paragraphs = text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: Chunk[] = [];
  let heading: string | null = null;
  let buffer = '';

  const flush = () => {
    const content = buffer.trim();
    if (content) chunks.push({ heading, content });
    buffer = '';
  };

  for (const para of paragraphs) {
    if (headings.has(para)) {
      flush();
      heading = para;
      continue;
    }
    if (para.length > maxChars) {
      flush();
      for (let i = 0; i < para.length; i += maxChars - overlap) {
        chunks.push({ heading, content: para.slice(i, i + maxChars) });
        if (i + maxChars >= para.length) break;
      }
      continue;
    }
    if (buffer.length + para.length + 1 > maxChars) {
      const tail = buffer.slice(-overlap);
      flush();
      buffer = tail ? `${tail.slice(tail.indexOf(' ') + 1)}\n` : '';
    }
    buffer += `${para}\n`;
  }
  flush();
  return chunks;
}

/** Extrai os textos dos títulos (h1–h4) do HTML. */
export function extractHeadings(html: string): string[] {
  const out: string[] = [];
  const re = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push(htmlToText(m[1]!));
  return out;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function cleanKeywords(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const kw = raw.trim().replace(/\s+/g, ' ').slice(0, 60);
    const key = normalize(kw);
    if (!kw || seen.has(key)) continue;
    seen.add(key);
    out.push(kw);
    if (out.length >= 30) break;
  }
  return out;
}
