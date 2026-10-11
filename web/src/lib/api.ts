/** Cliente HTTP da API. Envia o token CSRF em toda requisição que altera estado. */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: { fields?: Record<string, string>; [k: string]: unknown } | null,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;
export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

type Body = Record<string, unknown> | unknown[] | FormData | undefined;

export async function api<T = unknown>(method: string, url: string, body?: Body, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const unsafe = !['GET', 'HEAD'].includes(method.toUpperCase());
  if (unsafe && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  } else if (unsafe) {
    headers['Content-Type'] = 'application/json';
    payload = '{}';
  }
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin', ...init });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Não foi possível conectar ao servidor. Verifique sua conexão e tente novamente.');
  }
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: ApiError['details'] } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? `Erro ${res.status}`, err?.details ?? null);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const get = <T>(url: string) => api<T>('GET', url);
export const post = <T>(url: string, body?: Body) => api<T>('POST', url, body);
export const put = <T>(url: string, body?: Body) => api<T>('PUT', url, body);
export const del = <T>(url: string, body?: Body) => api<T>('DELETE', url, body);

/** Upload com acompanhamento de progresso (XMLHttpRequest). */
export function upload<T>(url: string, form: FormData, onProgress?: (pct: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    if (csrfToken) xhr.setRequestHeader('X-CSRF-Token', csrfToken);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      const data = safeJson(xhr.responseText) as { error?: { code: string; message: string; details?: ApiError['details'] } } | null;
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new ApiError(xhr.status, data?.error?.code ?? 'HTTP_ERROR', data?.error?.message ?? `Erro ${xhr.status}`, data?.error?.details ?? null));
    };
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK_ERROR', 'Falha de conexão durante o envio.'));
    xhr.send(form);
  });
}

export function qs(params: Record<string, string | number | undefined | null | boolean>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Ocorreu um erro inesperado.';
}

export function fieldErrors(err: unknown): Record<string, string> {
  return err instanceof ApiError ? (err.details?.fields ?? {}) : {};
}
