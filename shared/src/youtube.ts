/**
 * Validação de links do YouTube.
 *
 * Somente domínios oficiais são aceitos e somente o identificador do vídeo
 * (11 caracteres) é armazenado. Os endereços de incorporação são sempre
 * gerados a partir do identificador, nunca copiados da entrada do usuário.
 */

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

export function isValidYouTubeId(id: unknown): id is string {
  return typeof id === 'string' && VIDEO_ID_RE.test(id);
}

/** Extrai o identificador do vídeo de uma URL do YouTube. Retorna null se a URL não for válida. */
export function parseYouTubeUrl(input: string): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw || raw.length > 2048) return null;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return null;

  let id: string | null = null;
  const segments = url.pathname.split('/').filter(Boolean);

  if (host.endsWith('youtu.be')) {
    id = segments[0] ?? null;
  } else if (url.pathname === '/watch') {
    id = url.searchParams.get('v');
  } else if (['embed', 'shorts', 'live', 'v', 'e'].includes(segments[0] ?? '')) {
    id = segments[1] ?? null;
  }

  return isValidYouTubeId(id) ? id : null;
}

/** Converte o parâmetro de tempo (t=90, t=1m30s) em segundos. */
export function parseYouTubeStart(input: string): number | null {
  try {
    const url = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
    const t = url.searchParams.get('t') ?? url.searchParams.get('start');
    if (!t) return null;
    if (/^\d+$/.test(t)) return Number(t);
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
    if (!m) return null;
    const total = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
    return total > 0 ? total : null;
  } catch {
    return null;
  }
}

export function youTubeThumbnailUrl(id: string): string {
  if (!isValidYouTubeId(id)) throw new Error('Identificador de vídeo inválido');
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

/** Endereço de incorporação com o domínio de privacidade aprimorada (youtube-nocookie). */
export function youTubeEmbedUrl(id: string, opts: { autoplay?: boolean; start?: number | null } = {}): string {
  if (!isValidYouTubeId(id)) throw new Error('Identificador de vídeo inválido');
  const params = new URLSearchParams({ rel: '0', modestbranding: '1', playsinline: '1' });
  if (opts.autoplay) params.set('autoplay', '1');
  if (opts.start && Number.isInteger(opts.start) && opts.start > 0) params.set('start', String(opts.start));
  return `https://www.youtube-nocookie.com/embed/${id}?${params.toString()}`;
}

export function youTubeWatchUrl(id: string): string {
  if (!isValidYouTubeId(id)) throw new Error('Identificador de vídeo inválido');
  return `https://www.youtube.com/watch?v=${id}`;
}
