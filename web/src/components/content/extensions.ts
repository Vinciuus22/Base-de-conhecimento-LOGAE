import { Node, mergeAttributes, type AnyExtension } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TextAlign } from '@tiptap/extension-text-align';
import { TextStyle, FontFamily, FontSize, Color } from '@tiptap/extension-text-style';
import { Highlight } from '@tiptap/extension-highlight';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { CALLOUT_TYPES, type CalloutType } from '@shared/domain';
import { isValidYouTubeId } from '@shared/youtube';
import { CalloutView, VideoView, FigureImageView, AttachmentView } from './NodeViews';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (type: CalloutType) => ReturnType;
      toggleCallout: (type: CalloutType) => ReturnType;
      unsetCallout: () => ReturnType;
    };
    video: {
      insertVideo: (attrs: VideoAttrs) => ReturnType;
    };
    figureImage: {
      insertImage: (attrs: { src: string; alt?: string; caption?: string }) => ReturnType;
    };
    attachment: {
      insertAttachment: (attrs: { fileId: string; name: string; size?: number; mime?: string }) => ReturnType;
    };
  }
}

export interface VideoAttrs {
  provider: 'youtube' | 'upload';
  youtubeId?: string | null;
  start?: number | null;
  fileId?: string | null;
  posterId?: string | null;
  caption?: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bloco de destaque: <div data-callout="tipo">…</div> */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      type: {
        default: 'info',
        parseHTML: (el) => {
          const t = el.getAttribute('data-callout');
          return (CALLOUT_TYPES as readonly string[]).includes(t ?? '') ? t : 'info';
        },
        renderHTML: (attrs) => ({ 'data-callout': attrs.type }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', HTMLAttributes, 0];
  },
  addNodeView() {
    return ReactNodeViewRenderer(CalloutView);
  },
  addCommands() {
    return {
      setCallout:
        (type) =>
        ({ commands }) =>
          commands.wrapIn(this.name, { type }),
      toggleCallout:
        (type) =>
        ({ editor, commands }) => {
          if (editor.isActive(this.name)) {
            if (editor.isActive(this.name, { type })) return commands.lift(this.name);
            return commands.updateAttributes(this.name, { type });
          }
          return commands.wrapIn(this.name, { type });
        },
      unsetCallout:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
    };
  },
});

/** Vídeo (YouTube ou upload): <div data-video data-provider=…> — renderizado como miniatura + player ampliado. */
export const Video = Node.create({
  name: 'video',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      provider: { default: 'youtube', parseHTML: (el) => el.getAttribute('data-provider'), renderHTML: (a) => ({ 'data-provider': a.provider }) },
      youtubeId: {
        default: null,
        parseHTML: (el) => {
          const id = el.getAttribute('data-youtube-id');
          return isValidYouTubeId(id) ? id : null;
        },
        renderHTML: (a) => (a.youtubeId ? { 'data-youtube-id': a.youtubeId } : {}),
      },
      start: {
        default: null,
        parseHTML: (el) => {
          const v = Number(el.getAttribute('data-start'));
          return Number.isInteger(v) && v > 0 ? v : null;
        },
        renderHTML: (a) => (a.start ? { 'data-start': String(a.start) } : {}),
      },
      fileId: {
        default: null,
        parseHTML: (el) => (UUID_RE.test(el.getAttribute('data-file-id') ?? '') ? el.getAttribute('data-file-id') : null),
        renderHTML: (a) => (a.fileId ? { 'data-file-id': a.fileId } : {}),
      },
      posterId: {
        default: null,
        parseHTML: (el) => (UUID_RE.test(el.getAttribute('data-poster-id') ?? '') ? el.getAttribute('data-poster-id') : null),
        renderHTML: (a) => (a.posterId ? { 'data-poster-id': a.posterId } : {}),
      },
      caption: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-caption') ?? '',
        renderHTML: (a) => (a.caption ? { 'data-caption': a.caption } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-video]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-video': '' }, HTMLAttributes)];
  },
  addNodeView() {
    return ReactNodeViewRenderer(VideoView);
  },
  addCommands() {
    return {
      insertVideo:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    };
  },
});

/** Imagem com legenda, texto alternativo, alinhamento e largura. */
export const FigureImage = Node.create({
  name: 'figureImage',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: '' },
      caption: { default: '' },
      align: { default: 'center' },
      width: { default: 100 },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'figure[data-type="image"]',
        getAttrs: (el) => {
          const img = (el as HTMLElement).querySelector('img');
          if (!img) return false;
          const width = Number((el as HTMLElement).getAttribute('data-width'));
          return {
            src: img.getAttribute('src'),
            alt: img.getAttribute('alt') ?? '',
            caption: (el as HTMLElement).querySelector('figcaption')?.textContent ?? '',
            align: (el as HTMLElement).getAttribute('data-align') ?? 'center',
            width: width >= 10 && width <= 100 ? width : 100,
          };
        },
      },
      {
        tag: 'img[src]',
        getAttrs: (el) => ({ src: (el as HTMLElement).getAttribute('src'), alt: (el as HTMLElement).getAttribute('alt') ?? '' }),
      },
    ];
  },
  renderHTML({ node }) {
    const { src, alt, caption, align, width } = node.attrs;
    const figure: Record<string, string> = { 'data-type': 'image', 'data-align': align, 'data-width': String(width) };
    return caption
      ? ['figure', figure, ['img', { src, alt }], ['figcaption', {}, caption]]
      : ['figure', figure, ['img', { src, alt }]];
  },
  addNodeView() {
    return ReactNodeViewRenderer(FigureImageView);
  },
  addCommands() {
    return {
      insertImage:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { ...attrs, align: 'center', width: 100 } }),
    };
  },
});

/** Anexo para download: <div data-attachment data-file-id …> */
export const Attachment = Node.create({
  name: 'attachment',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      fileId: { default: null, parseHTML: (el) => el.getAttribute('data-file-id'), renderHTML: (a) => ({ 'data-file-id': a.fileId }) },
      name: { default: 'anexo', parseHTML: (el) => el.getAttribute('data-name'), renderHTML: (a) => ({ 'data-name': a.name }) },
      size: {
        default: null,
        parseHTML: (el) => Number(el.getAttribute('data-size')) || null,
        renderHTML: (a) => (a.size ? { 'data-size': String(a.size) } : {}),
      },
      mime: { default: null, parseHTML: (el) => el.getAttribute('data-mime'), renderHTML: (a) => (a.mime ? { 'data-mime': a.mime } : {}) },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-attachment]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-attachment': '' }, HTMLAttributes)];
  },
  addNodeView() {
    return ReactNodeViewRenderer(AttachmentView);
  },
  addCommands() {
    return {
      insertAttachment:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    };
  },
});

const LINK_RE = /^(https?:\/\/|mailto:|\/(?!\/)|#)/i;

export function buildExtensions(opts: { editable: boolean; placeholder?: string }): AnyExtension[] {
  const list: AnyExtension[] = [
    StarterKit.configure({
      heading: { levels: [2, 3, 4] },
      // Evita alterar o documento automaticamente ao carregar (falso "alterações não salvas").
      trailingNode: false,
      codeBlock: { languageClassPrefix: 'language-' },
      link: {
        openOnClick: false,
        autolink: true,
        protocols: ['http', 'https', 'mailto'],
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
        // Somente http(s), mailto e caminhos internos (o servidor valida novamente).
        isAllowedUri: (url) => LINK_RE.test(url),
      },
    }),
    TextStyle,
    FontFamily,
    FontSize,
    Color,
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Table.configure({ resizable: opts.editable }),
    TableRow,
    TableHeader,
    TableCell,
    Callout,
    Video,
    FigureImage,
    Attachment,
  ];
  if (opts.editable && opts.placeholder) list.push(Placeholder.configure({ placeholder: opts.placeholder }));
  return list;
}

export const FONT_FAMILIES = [
  { label: 'Padrão', value: '' },
  { label: 'Arial', value: 'Arial, sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times New Roman', value: '"Times New Roman", serif' },
  { label: 'Verdana', value: 'Verdana, sans-serif' },
  { label: 'Trebuchet MS', value: '"Trebuchet MS", sans-serif' },
  { label: 'Courier New', value: '"Courier New", monospace' },
];

export const FONT_SIZES = ['12px', '14px', '16px', '18px', '20px', '24px', '28px', '32px'];

export const TEXT_COLORS = ['#17202c', '#556171', '#b91c1c', '#c2410c', '#a16207', '#15803d', '#0e7490', '#1d4ed8', '#6d28d9', '#be185d'];
export const HIGHLIGHT_COLORS = ['#fde68a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#fed7aa', '#e9d5ff'];
