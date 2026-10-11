import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Highlighted, HighlightTerms } from './ui';

describe('destaque de termos', () => {
  it('converte marcadores do servidor em <mark> sem interpretar HTML', () => {
    const { container } = render(<Highlighted text={'antes \u0002<b>erro</b>\u0003 depois'} />);
    const mark = container.querySelector('mark')!;
    expect(mark.textContent).toBe('<b>erro</b>');
    expect(container.querySelector('b')).toBeNull();
  });
  it('destaca termos ignorando acentos e preservando o texto original', () => {
    const { container } = render(<HighlightTerms text="Exportação de relatórios" terms={['exportacao', 'relatorios']} />);
    const marks = [...container.querySelectorAll('mark')].map((m) => m.textContent);
    expect(marks).toEqual(['Exportação', 'relatórios']);
  });
});
