import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, setTimeZone } from './format';
import { qs } from './api';

describe('formatação de datas no fuso configurado', () => {
  it('converte UTC para o fuso de São Paulo', () => {
    setTimeZone('America/Sao_Paulo');
    expect(formatDateTime('2026-10-11T15:30:00Z')).toBe('11/10/2026 às 12:30');
    expect(formatDate('2026-01-01T01:00:00Z')).toBe('31/12/2025');
  });
  it('trata valores ausentes', () => {
    expect(formatDateTime(null)).toBe('-');
  });
});

describe('query string', () => {
  it('omite valores vazios', () => {
    expect(qs({ q: 'erro', page: 1, status: '', x: undefined, y: false })).toBe('?q=erro&page=1');
  });
});
