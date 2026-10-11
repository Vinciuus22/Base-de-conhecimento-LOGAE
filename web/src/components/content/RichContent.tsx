import { useEffect, useMemo, useRef } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { buildExtensions } from './extensions';

export interface TocItem {
  id: string;
  text: string;
  level: number;
}

function slug(text: string) {
  return (
    text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'secao'
  );
}

/**
 * Renderização SOMENTE LEITURA do conteúdo, com as mesmas extensões do editor.
 * Usada no artigo publicado e na pré-visualização: o comportamento (miniaturas
 * de vídeo, player ampliado, destaques, anexos) é idêntico nos dois casos.
 * O HTML já chega sanitizado pelo servidor e é reinterpretado pelo esquema do
 * editor, que descarta qualquer elemento fora da lista permitida.
 */
export function RichContent({ html, onToc }: { html: string; onToc?: (toc: TocItem[]) => void }) {
  const extensions = useMemo(() => buildExtensions({ editable: false }), []);
  const ref = useRef<HTMLDivElement>(null);
  const editor = useEditor({ extensions, content: html, editable: false, immediatelyRender: true }, []);

  useEffect(() => {
    if (editor && editor.getHTML() !== html) editor.commands.setContent(html, { emitUpdate: false });
  }, [editor, html]);

  useEffect(() => {
    if (!editor || !ref.current) return;
    const used = new Set<string>();
    const items: TocItem[] = [];
    ref.current.querySelectorAll<HTMLHeadingElement>('h2, h3').forEach((h) => {
      let id = slug(h.textContent ?? '');
      while (used.has(id)) id = `${id}-x`;
      used.add(id);
      h.id = id;
      items.push({ id, text: h.textContent ?? '', level: Number(h.tagName[1]) });
    });
    onToc?.(items);
  }, [editor, html, onToc]);

  return (
    <div ref={ref} className="rich-content">
      <EditorContent editor={editor} />
    </div>
  );
}
