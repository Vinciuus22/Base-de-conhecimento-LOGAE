import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Code,
  Highlighter,
  Image as ImageIcon,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Paperclip,
  Quote,
  Redo2,
  SquareCode,
  Strikethrough,
  Table as TableIcon,
  Underline as UnderlineIcon,
  Undo2,
  Video as VideoIcon,
  Palette,
  Trash2,
  Rows3,
  Columns3,
} from 'lucide-react';
import { CALLOUT_LABELS, CALLOUT_TYPES, type CalloutType } from '@shared/domain';
import { useAuth } from '../../context/AuthContext';
import { errorMessage } from '../../lib/api';
import { buildExtensions, FONT_FAMILIES, FONT_SIZES, HIGHLIGHT_COLORS, TEXT_COLORS } from '../content/extensions';
import { CALLOUT_ICONS } from '../content/NodeViews';
import { useToast } from '../ui';
import { LinkDialog, VideoDialog, checkFileClientSide, uploadMedia } from './MediaDialogs';

function TB({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="tb-btn"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ColorMenu({ label, icon, colors, onPick, onClear }: { label: string; icon: ReactNode; colors: string[]; onPick: (c: string) => void; onClear: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tb-menu">
      <TB label={label} onClick={() => setOpen((o) => !o)} active={open}>
        {icon}
      </TB>
      {open && (
        <div className="tb-popover" role="menu" onMouseLeave={() => setOpen(false)}>
          <div className="tb-swatches">
            {colors.map((c) => (
              <button
                key={c}
                type="button"
                role="menuitem"
                className="tb-swatch"
                style={{ background: c }}
                aria-label={`Cor ${c}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onPick(c);
                  setOpen(false);
                }}
              />
            ))}
          </div>
          <label className="small row" style={{ gap: 6, marginTop: 6 }}>
            Personalizada:
            <input type="color" onChange={(e) => onPick(e.target.value)} aria-label="Cor personalizada" />
          </label>
          <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => (onClear(), setOpen(false))}>
            Remover cor
          </button>
        </div>
      )}
    </div>
  );
}

function CalloutMenu({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const active = editor.isActive('callout');
  return (
    <div className="tb-menu">
      <TB label="Bloco de destaque (atenção, alerta, importante, dica, informação)" active={active || open} onClick={() => setOpen((o) => !o)}>
        <span style={{ fontSize: 12, fontWeight: 700 }}>Destaque</span>
      </TB>
      {open && (
        <div className="tb-popover" role="menu" onMouseLeave={() => setOpen(false)} style={{ minWidth: 200 }}>
          <p className="tiny muted" style={{ margin: '0 0 6px' }}>Selecione o trecho e escolha o tipo:</p>
          {CALLOUT_TYPES.map((t) => {
            const Icon = CALLOUT_ICONS[t as CalloutType];
            return (
              <button
                key={t}
                type="button"
                role="menuitem"
                className={`tb-callout-item callout-${t}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  editor.chain().focus().toggleCallout(t).run();
                  setOpen(false);
                }}
              >
                <Icon size={16} aria-hidden /> {CALLOUT_LABELS[t]}
              </button>
            );
          })}
          {active && (
            <button type="button" className="btn btn-sm" style={{ marginTop: 6, width: '100%' }} onClick={() => (editor.chain().focus().unsetCallout().run(), setOpen(false))}>
              Remover destaque
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export interface RichEditorProps {
  initialHtml: string;
  onChange: (html: string) => void;
  editable?: boolean;
  placeholder?: string;
  onReady?: (editor: Editor) => void;
}

/** Editor de conteúdo rico (somente para usuários internos autorizados; o backend sanitiza tudo ao salvar). */
export function RichEditor({ initialHtml, onChange, editable = true, placeholder = 'Escreva o conteúdo do artigo…', onReady }: RichEditorProps) {
  const { config } = useAuth();
  const toast = useToast();
  const extensions = useMemo(() => buildExtensions({ editable: true, placeholder }), [placeholder]);
  const [linkOpen, setLinkOpen] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const attachInput = useRef<HTMLInputElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const baseline = useRef<string | null>(null);
  const [, force] = useState(0);

  const insertFiles = async (files: File[], ed: Editor, pos?: number) => {
    for (const file of files) {
      const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'attachment';
      const problem = config && checkFileClientSide(file, kind, config.uploads);
      if (problem) {
        toast('error', `${file.name}: ${problem}`);
        continue;
      }
      try {
        setUploading(`Enviando ${file.name}…`);
        const res = await uploadMedia(file, (p) => setUploading(`Enviando ${file.name}… ${p}%`));
        const chain = ed.chain().focus();
        if (pos !== undefined) chain.setTextSelection(pos);
        if (kind === 'image') chain.insertImage({ src: res.file.url, alt: '' }).run();
        else if (kind === 'video') chain.insertVideo({ provider: 'upload', fileId: res.file.id, caption: '' }).run();
        else chain.insertAttachment({ fileId: res.file.id, name: res.file.name, size: res.file.size, mime: res.file.mimeType }).run();
        if (res.warning) toast('info', res.warning);
      } catch (err) {
        toast('error', `${file.name}: ${errorMessage(err)}`);
      } finally {
        setUploading(null);
      }
    }
  };

  const editor = useEditor(
    {
      extensions,
      content: initialHtml,
      editable,
      immediatelyRender: true,
      editorProps: {
        attributes: { class: 'rich-content editor-surface', 'aria-label': 'Conteúdo do artigo', role: 'textbox', 'aria-multiline': 'true' },
        handlePaste: (_view, event) => {
          const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
          if (!files.length || !editorRef.current) return false;
          event.preventDefault();
          void insertFiles(files, editorRef.current);
          return true;
        },
        handleDrop: (view, event) => {
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (!files.length || !editorRef.current) return false;
          event.preventDefault();
          const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
          void insertFiles(files, editorRef.current, pos);
          return true;
        },
      },
      // Só considera alterações reais do documento em relação ao conteúdo carregado.
      onCreate: ({ editor: ed }) => {
        baseline.current = ed.getHTML();
      },
      onUpdate: ({ editor: ed, transaction }) => {
        if (!transaction.docChanged) return;
        const html = ed.getHTML();
        if (html === baseline.current) return;
        baseline.current = null;
        onChange(html);
      },
      onSelectionUpdate: () => force((n) => n + 1),
      onTransaction: () => force((n) => n + 1),
    },
    [],
  );

  useEffect(() => {
    editorRef.current = editor;
    if (editor) onReady?.(editor);
  }, [editor, onReady]);

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  if (!editor) return null;
  const inTable = editor.isActive('table');
  const heading = [2, 3, 4].find((l) => editor.isActive('heading', { level: l }));
  const fontFamily = (editor.getAttributes('textStyle').fontFamily as string) ?? '';
  const fontSize = (editor.getAttributes('textStyle').fontSize as string) ?? '';

  return (
    <div className="editor">
      {editable && (
        <div className="editor-toolbar" role="toolbar" aria-label="Formatação">
          <div className="tb-group">
            <TB label="Desfazer (Ctrl+Z)" disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}>
              <Undo2 size={16} />
            </TB>
            <TB label="Refazer (Ctrl+Y)" disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}>
              <Redo2 size={16} />
            </TB>
          </div>
          <div className="tb-group">
            <select
              className="tb-select"
              aria-label="Estilo do parágrafo"
              value={heading ? String(heading) : 'p'}
              onChange={(e) => {
                const v = e.target.value;
                if (v === 'p') editor.chain().focus().setParagraph().run();
                else editor.chain().focus().setHeading({ level: Number(v) as 2 | 3 | 4 }).run();
              }}
            >
              <option value="p">Parágrafo</option>
              <option value="2">Título</option>
              <option value="3">Subtítulo</option>
              <option value="4">Subtítulo menor</option>
            </select>
            <select
              className="tb-select"
              aria-label="Fonte"
              value={fontFamily}
              onChange={(e) => (e.target.value ? editor.chain().focus().setFontFamily(e.target.value).run() : editor.chain().focus().unsetFontFamily().run())}
            >
              {FONT_FAMILIES.map((f) => (
                <option key={f.label} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <select
              className="tb-select"
              aria-label="Tamanho da fonte"
              value={fontSize}
              onChange={(e) => (e.target.value ? editor.chain().focus().setFontSize(e.target.value).run() : editor.chain().focus().unsetFontSize().run())}
            >
              <option value="">Tamanho</option>
              {FONT_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s.replace('px', '')}
                </option>
              ))}
            </select>
          </div>
          <div className="tb-group">
            <TB label="Negrito (Ctrl+B)" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
              <Bold size={16} />
            </TB>
            <TB label="Itálico (Ctrl+I)" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
              <Italic size={16} />
            </TB>
            <TB label="Sublinhado (Ctrl+U)" active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()}>
              <UnderlineIcon size={16} />
            </TB>
            <TB label="Tachado" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}>
              <Strikethrough size={16} />
            </TB>
            <TB label="Código em linha" active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}>
              <Code size={16} />
            </TB>
            <ColorMenu label="Cor do texto" icon={<Palette size={16} />} colors={TEXT_COLORS} onPick={(c) => editor.chain().focus().setColor(c).run()} onClear={() => editor.chain().focus().unsetColor().run()} />
            <ColorMenu label="Destacar trecho" icon={<Highlighter size={16} />} colors={HIGHLIGHT_COLORS} onPick={(c) => editor.chain().focus().setHighlight({ color: c }).run()} onClear={() => editor.chain().focus().unsetHighlight().run()} />
          </div>
          <div className="tb-group">
            {(
              [
                ['left', AlignLeft, 'Alinhar à esquerda'],
                ['center', AlignCenter, 'Centralizar'],
                ['right', AlignRight, 'Alinhar à direita'],
                ['justify', AlignJustify, 'Justificar'],
              ] as const
            ).map(([a, Icon, label]) => (
              <TB key={a} label={label} active={editor.isActive({ textAlign: a })} onClick={() => editor.chain().focus().setTextAlign(a).run()}>
                <Icon size={16} />
              </TB>
            ))}
          </div>
          <div className="tb-group">
            <TB label="Lista com marcadores" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}>
              <List size={16} />
            </TB>
            <TB label="Lista numerada" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
              <ListOrdered size={16} />
            </TB>
            <TB label="Citação" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
              <Quote size={16} />
            </TB>
            <TB label="Bloco de código / comando" active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
              <SquareCode size={16} />
            </TB>
            <TB label="Linha divisória" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
              <Minus size={16} />
            </TB>
            <CalloutMenu editor={editor} />
          </div>
          <div className="tb-group">
            <TB label="Link" active={editor.isActive('link')} onClick={() => setLinkOpen(true)}>
              <Link2 size={16} />
            </TB>
            <TB label="Inserir tabela" onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
              <TableIcon size={16} />
            </TB>
            <TB label="Inserir imagem ou GIF" onClick={() => imageInput.current?.click()}>
              <ImageIcon size={16} />
            </TB>
            <TB label="Inserir vídeo (YouTube ou arquivo)" onClick={() => setVideoOpen(true)}>
              <VideoIcon size={16} />
            </TB>
            <TB label="Inserir anexo" onClick={() => attachInput.current?.click()}>
              <Paperclip size={16} />
            </TB>
          </div>
          {inTable && (
            <div className="tb-group" aria-label="Tabela">
              <TB label="Adicionar linha abaixo" onClick={() => editor.chain().focus().addRowAfter().run()}>
                <Rows3 size={16} />
              </TB>
              <TB label="Adicionar coluna à direita" onClick={() => editor.chain().focus().addColumnAfter().run()}>
                <Columns3 size={16} />
              </TB>
              <TB label="Excluir linha" onClick={() => editor.chain().focus().deleteRow().run()}>
                <span style={{ fontSize: 11, fontWeight: 700 }}>−L</span>
              </TB>
              <TB label="Excluir coluna" onClick={() => editor.chain().focus().deleteColumn().run()}>
                <span style={{ fontSize: 11, fontWeight: 700 }}>−C</span>
              </TB>
              <TB label="Alternar linha de cabeçalho" onClick={() => editor.chain().focus().toggleHeaderRow().run()}>
                <span style={{ fontSize: 11, fontWeight: 700 }}>Cab.</span>
              </TB>
              <TB label="Excluir tabela" onClick={() => editor.chain().focus().deleteTable().run()}>
                <Trash2 size={16} />
              </TB>
            </div>
          )}
          <input
            ref={imageInput}
            type="file"
            hidden
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            onChange={(e) => {
              void insertFiles(Array.from(e.target.files ?? []), editor);
              e.target.value = '';
            }}
          />
          <input
            ref={attachInput}
            type="file"
            hidden
            onChange={(e) => {
              void insertFiles(Array.from(e.target.files ?? []).map((f) => f), editor);
              e.target.value = '';
            }}
          />
        </div>
      )}
      {uploading && (
        <div className="small muted" role="status" style={{ padding: '6px 12px' }}>
          {uploading}
        </div>
      )}
      <EditorContent editor={editor} />
      {linkOpen && (
        <LinkDialog
          initial={(editor.getAttributes('link').href as string) ?? ''}
          onClose={() => setLinkOpen(false)}
          onRemove={() => {
            editor.chain().focus().extendMarkRange('link').unsetLink().run();
            setLinkOpen(false);
          }}
          onSubmit={(href) => {
            const chain = editor.chain().focus().extendMarkRange('link');
            if (editor.state.selection.empty && !editor.isActive('link')) chain.insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run();
            else chain.setLink({ href }).run();
            setLinkOpen(false);
          }}
        />
      )}
      {videoOpen && (
        <VideoDialog
          onClose={() => setVideoOpen(false)}
          onInsert={(attrs) => {
            editor.chain().focus().insertVideo(attrs).run();
            setVideoOpen(false);
          }}
        />
      )}
    </div>
  );
}
