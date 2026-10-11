/** Formatação de datas no fuso horário configurado no servidor (timestamps armazenados em UTC). */

let timeZone = 'America/Sao_Paulo';
export function setTimeZone(tz: string) {
  timeZone = tz;
}
export function getTimeZone() {
  return timeZone;
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(value: string | Date | null | undefined): string {
  const d = toDate(value);
  return d ? new Intl.DateTimeFormat('pt-BR', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(d) : '-';
}

export function formatTime(value: string | Date | null | undefined): string {
  const d = toDate(value);
  return d ? new Intl.DateTimeFormat('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit' }).format(d) : '-';
}

export function formatDateTime(value: string | Date | null | undefined): string {
  const d = toDate(value);
  return d ? `${formatDate(d)} às ${formatTime(d)}` : '-';
}

export function relativeTime(value: string | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return '-';
  const diff = (Date.now() - d.getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
  if (Math.abs(diff) < 60) return 'agora mesmo';
  if (Math.abs(diff) < 3600) return rtf.format(-Math.round(diff / 60), 'minute');
  if (Math.abs(diff) < 86400) return rtf.format(-Math.round(diff / 3600), 'hour');
  if (Math.abs(diff) < 86400 * 30) return rtf.format(-Math.round(diff / 86400), 'day');
  return formatDate(d);
}
