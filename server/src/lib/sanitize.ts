import sanitizeHtml from 'sanitize-html';
import { CALLOUT_TYPES } from '@shared/domain.js';

/**
 * Sanitização do conteúdo rico (artigos e comunicados).
 *
 * O conteúdo é tratado como NÃO CONFIÁVEL: apenas as tags, atributos, estilos
 * e esquemas de URL desta lista são preservados. Scripts, eventos (onclick…),
 * iframes e URLs javascript: são removidos. Vídeos do YouTube são armazenados
 * somente pelo identificador; o iframe é gerado na renderização.
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const FILE_URL_RE = new RegExp(`^/api/files/(${UUID})(\\?variant=(thumb|original))?$`, 'i');
const UUID_RE = new RegExp(`^${UUID}$`, 'i');
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)|inherit|transparent|var\(--[a-z0-9-]+\))$/i;
const FONT_FAMILY_RE = /^[A-Za-z0-9 "',-]{1,120}$/;
const FONT_SIZE_RE = /^\d{1,2}(\.\d)?(px|pt|em|rem)$/;
const LENGTH_RE = /^\d{1,4}(px|%)$/;

function safeHref(href: string | undefined): string | null {
  if (!href) return null;
  const v = href.trim();
  if (/^(https?:|mailto:)/i.test(v)) {
    try {
      const u = new URL(v);
      return u.toString();
    } catch {
      return null;
    }
  }
  if (/^\/(?!\/)/.test(v) || /^#[\w-]{1,100}$/.test(v)) return v;
  return null;
}

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'h1', 'h2', 'h3', 'h4', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'code', 'pre',
    'blockquote', 'ul', 'ol', 'li', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'colgroup', 'col',
    'hr', 'span', 'mark', 'div', 'figure', 'figcaption', 'img',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel', 'title'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    span: ['style'],
    mark: ['style', 'data-color'],
    p: ['style'],
    h1: ['style'], h2: ['style'], h3: ['style'], h4: ['style'],
    li: ['style'],
    code: ['class'],
    pre: ['class'],
    table: ['style'],
    col: ['style'],
    td: ['colspan', 'rowspan', 'colwidth', 'style'],
    th: ['colspan', 'rowspan', 'colwidth', 'style'],
    ol: ['start'],
    div: [
      'data-callout', 'data-video', 'data-provider', 'data-youtube-id', 'data-start', 'data-file-id',
      'data-poster-id', 'data-caption', 'data-attachment', 'data-name', 'data-size', 'data-mime',
    ],
    figure: ['data-type', 'data-align', 'data-width'],
  },
  allowedStyles: {
    '*': {
      color: [COLOR_RE],
      'background-color': [COLOR_RE],
      'font-family': [FONT_FAMILY_RE],
      'font-size': [FONT_SIZE_RE],
      'text-align': [/^(left|right|center|justify)$/],
      'min-width': [LENGTH_RE],
      width: [LENGTH_RE],
    },
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math', 'template'],
  transformTags: {
    a: (tagName, attribs) => {
      const href = safeHref(attribs.href);
      const out: Record<string, string> = {};
      if (href) out.href = href;
      if (attribs.title) out.title = attribs.title;
      if (href && /^https?:/i.test(href)) {
        out.target = '_blank';
        out.rel = 'noopener noreferrer nofollow';
      }
      return { tagName, attribs: out };
    },
    img: (tagName, attribs) => {
      // Somente imagens hospedadas pela própria aplicação (controle de acesso por arquivo).
      if (!attribs.src || !FILE_URL_RE.test(attribs.src)) return { tagName: 'span', attribs: {} };
      const out: Record<string, string> = { src: attribs.src, alt: (attribs.alt ?? '').slice(0, 300) };
      if (attribs.title) out.title = attribs.title.slice(0, 300);
      for (const k of ['width', 'height'] as const) {
        if (attribs[k] && /^\d{1,4}$/.test(attribs[k]!)) out[k] = attribs[k]!;
      }
      return { tagName, attribs: out };
    },
    code: (tagName, attribs) => ({
      tagName,
      attribs: (attribs.class && /^language-[a-z0-9+#-]{1,30}$/i.test(attribs.class) ? { class: attribs.class } : {}) as Record<string, string>,
    }),
    pre: (tagName) => ({ tagName, attribs: {} }),
    div: (tagName, attribs) => {
      if (attribs['data-callout'] !== undefined) {
        const type = (CALLOUT_TYPES as readonly string[]).includes(attribs['data-callout']!) ? attribs['data-callout']! : 'info';
        return { tagName, attribs: { 'data-callout': type } };
      }
      if (attribs['data-video'] !== undefined) {
        const out: Record<string, string> = { 'data-video': '' };
        const caption = (attribs['data-caption'] ?? '').slice(0, 300);
        if (caption) out['data-caption'] = caption;
        if (attribs['data-provider'] === 'youtube' && YT_ID_RE.test(attribs['data-youtube-id'] ?? '')) {
          out['data-provider'] = 'youtube';
          out['data-youtube-id'] = attribs['data-youtube-id']!;
          if (/^\d{1,6}$/.test(attribs['data-start'] ?? '')) out['data-start'] = attribs['data-start']!;
          return { tagName, attribs: out };
        }
        if (attribs['data-provider'] === 'upload' && UUID_RE.test(attribs['data-file-id'] ?? '')) {
          out['data-provider'] = 'upload';
          out['data-file-id'] = attribs['data-file-id']!.toLowerCase();
          if (UUID_RE.test(attribs['data-poster-id'] ?? '')) out['data-poster-id'] = attribs['data-poster-id']!.toLowerCase();
          return { tagName, attribs: out };
        }
        // Vídeo inválido é descartado.
        return { tagName: 'span', attribs: {} };
      }
      if (attribs['data-attachment'] !== undefined) {
        if (!UUID_RE.test(attribs['data-file-id'] ?? '')) return { tagName: 'span', attribs: {} };
        return {
          tagName,
          attribs: {
            'data-attachment': '',
            'data-file-id': attribs['data-file-id']!.toLowerCase(),
            'data-name': (attribs['data-name'] ?? 'anexo').slice(0, 200),
            ...(attribs['data-size'] && /^\d{1,12}$/.test(attribs['data-size']) ? { 'data-size': attribs['data-size'] } : {}),
            ...(attribs['data-mime'] && /^[\w.+-]+\/[\w.+-]+$/.test(attribs['data-mime']) ? { 'data-mime': attribs['data-mime'] } : {}),
          },
        };
      }
      return { tagName, attribs: {} };
    },
    figure: (tagName, attribs) => {
      const out: Record<string, string> = { 'data-type': 'image' };
      if (['left', 'center', 'right'].includes(attribs['data-align'] ?? '')) out['data-align'] = attribs['data-align']!;
      if (/^(\d{2}|100)$/.test(attribs['data-width'] ?? '')) out['data-width'] = attribs['data-width']!;
      return { tagName, attribs: out };
    },
  },
  exclusiveFilter: (frame) => frame.tag === 'span' && !frame.text.trim() && Object.keys(frame.attribs).length === 0 && frame.mediaChildren.length === 0,
};

export const MAX_CONTENT_HTML_LENGTH = 2_000_000;

export function sanitizeRichHtml(html: string): string {
  if (typeof html !== 'string') return '';
  return sanitizeHtml(html, OPTIONS).trim();
}

/** Identificadores de arquivos referenciados pelo conteúdo (imagens, vídeos, anexos). */
export function referencedFileIds(html: string): string[] {
  const ids = new Set<string>();
  const re = new RegExp(`(?:/api/files/|data-(?:file|poster)-id=")(${UUID})`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) ids.add(m[1]!.toLowerCase());
  return [...ids];
}

/**
 * Normalização de texto simples (mensagens de tickets, observações).
 * O texto é armazenado como texto puro e SEMPRE renderizado com escape no
 * frontend (nunca como HTML); aqui removemos apenas caracteres de controle.
 */
export function sanitizePlainText(text: string, maxLength = 20_000): string {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, maxLength)
    .trim();
}
