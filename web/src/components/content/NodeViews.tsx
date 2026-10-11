import { useEffect, useState } from 'react';
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import {
  AlertOctagon,
  AlertTriangle,
  AlignCenter,
  AlignLeft,
  AlignRight,
  Download,
  FileText,
  Image as ImageIcon,
  Info,
  Lightbulb,
  Play,
  Star,
  Trash2,
  Upload,
  Video as VideoIcon,
} from 'lucide-react';
import { CALLOUT_LABELS, CALLOUT_TYPES, type CalloutType } from '@shared/domain';
import { youTubeThumbnailUrl, isValidYouTubeId } from '@shared/youtube';
import { formatBytes } from '@shared/uploads';
import { useMedia } from './MediaContext';
import { upload, errorMessage } from '../../lib/api';
import type { UploadedFile } from '../../lib/types';

export const CALLOUT_ICONS: Record<CalloutType, typeof Info> = {
  atencao: AlertTriangle,
  alerta: AlertOctagon,
  importante: Star,
  dica: Lightbulb,
  info: Info,
};

export function CalloutView({ node, editor, updateAttributes }: NodeViewProps) {
  const type = (CALLOUT_TYPES as readonly string[]).includes(node.attrs.type) ? (node.attrs.type as CalloutType) : 'info';
  const Icon = CALLOUT_ICONS[type];
  return (
    <NodeViewWrapper className={`callout callout-${type}`} data-callout={type} role="note" aria-label={CALLOUT_LABELS[type]}>
      <span className="callout-icon" contentEditable={false} aria-hidden>
        <Icon size={20} />
      </span>
      <div className="callout-body">
        <span className="callout-title" contentEditable={false}>
          {editor.isEditable ? (
            <select
              aria-label="Tipo do destaque"
              value={type}
              onChange={(e) => updateAttributes({ type: e.target.value })}
              style={{ font: 'inherit', textTransform: 'uppercase', border: 0, background: 'transparent', color: 'inherit', fontWeight: 700, cursor: 'pointer' }}
            >
              {CALLOUT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {CALLOUT_LABELS[t]}
                </option>
              ))}
            </select>
          ) : (
            CALLOUT_LABELS[type]
          )}
        </span>
        <NodeViewContent />
      </div>
    </NodeViewWrapper>
  );
}

export function VideoView({ node, editor, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const media = useMedia();
  const { provider, youtubeId, start, fileId, posterId, caption } = node.attrs as {
    provider: 'youtube' | 'upload';
    youtubeId: string | null;
    start: number | null;
    fileId: string | null;
    posterId: string | null;
    caption: string;
  };
  const [coverError, setCoverError] = useState<string | null>(null);
  const [thumbFailed, setThumbFailed] = useState(false);
  const [uploadingCover, setUploadingCover] = useState(false);
  const editable = editor.isEditable;

  const valid = provider === 'youtube' ? isValidYouTubeId(youtubeId) : !!fileId;
  const thumb =
    provider === 'youtube' && youtubeId && isValidYouTubeId(youtubeId)
      ? youTubeThumbnailUrl(youtubeId)
      : posterId
        ? `/api/files/${posterId}`
        : fileId
          ? `/api/files/${fileId}?variant=thumb`
          : null;

  useEffect(() => setThumbFailed(false), [thumb]);

  const play = () => {
    if (!valid) return;
    if (provider === 'youtube') media.open({ kind: 'youtube', youtubeId: youtubeId!, start, title: caption || 'Vídeo do YouTube' });
    else media.open({ kind: 'upload', src: `/api/files/${fileId}`, poster: thumb, title: caption || 'Vídeo' });
  };

  const onCover = async (file: File | undefined) => {
    if (!file || !fileId) return;
    setCoverError(null);
    setUploadingCover(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await upload<{ file: UploadedFile }>(`/api/files/${fileId}/cover`, form);
      updateAttributes({ posterId: res.file.thumbnailId });
    } catch (err) {
      setCoverError(errorMessage(err));
    } finally {
      setUploadingCover(false);
    }
  };

  return (
    <NodeViewWrapper className="video-embed" data-video="" style={selected && editable ? { outline: '3px solid var(--focus)', borderRadius: 12 } : undefined}>
      <button type="button" className="video-thumb" onClick={play} aria-label={`Reproduzir vídeo${caption ? `: ${caption}` : ''}`} contentEditable={false}>
        {thumb && !thumbFailed ? (
          <img src={thumb} alt="" loading="lazy" draggable={false} onError={() => setThumbFailed(true)} />
        ) : (
          <span className="no-thumb">
            <VideoIcon size={40} aria-hidden />
          </span>
        )}
        <span className="play" aria-hidden>
          <span>
            <Play size={30} fill="currentColor" />
          </span>
        </span>
        <span className="badge-provider">{provider === 'youtube' ? 'YouTube' : 'Vídeo'}</span>
      </button>
      {editable ? (
        <div contentEditable={false} className="stack" style={{ gap: 6, marginTop: 8 }}>
          <input
            className="input"
            placeholder="Legenda do vídeo (opcional)"
            aria-label="Legenda do vídeo"
            value={caption}
            onChange={(e) => updateAttributes({ caption: e.target.value })}
          />
          <div className="row" style={{ gap: 6 }}>
            {provider === 'upload' && (
              <label className="btn btn-sm">
                <Upload size={14} aria-hidden /> {uploadingCover ? 'Enviando…' : 'Imagem de capa'}
                <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => onCover(e.target.files?.[0])} />
              </label>
            )}
            <button type="button" className="btn btn-sm" onClick={() => deleteNode()}>
              <Trash2 size={14} aria-hidden /> Remover vídeo
            </button>
          </div>
          {coverError && <span className="small" style={{ color: 'var(--danger)' }}>{coverError}</span>}
        </div>
      ) : (
        caption && <div className="video-caption">{caption}</div>
      )}
    </NodeViewWrapper>
  );
}

export function FigureImageView({ node, editor, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const media = useMedia();
  const { src, alt, caption, align, width } = node.attrs as { src: string; alt: string; caption: string; align: string; width: number };
  const editable = editor.isEditable;
  return (
    <NodeViewWrapper as="figure" className="figure" data-align={align} style={{ width: `${width}%` }}>
      <img
        src={src}
        alt={alt}
        loading="lazy"
        draggable={false}
        onClick={() => !editable && media.open({ kind: 'image', src, alt })}
        style={selected && editable ? { outline: '3px solid var(--focus)' } : undefined}
      />
      {editable ? (
        <div contentEditable={false} className="stack" style={{ gap: 6, marginTop: 8, display: 'flex' }}>
          <div className="row" style={{ gap: 6 }}>
            <span className="small muted">Alinhamento:</span>
            {(
              [
                ['left', AlignLeft],
                ['center', AlignCenter],
                ['right', AlignRight],
              ] as const
            ).map(([a, Icon]) => (
              <button key={a} type="button" className="btn btn-sm btn-icon" aria-pressed={align === a} aria-label={`Alinhar ${a}`} onClick={() => updateAttributes({ align: a })} style={align === a ? { background: 'var(--primary-soft)' } : undefined}>
                <Icon size={14} aria-hidden />
              </button>
            ))}
            <label className="small muted" htmlFor={`w-${src}`}>
              Largura:
            </label>
            <select id={`w-${src}`} className="select" style={{ width: 'auto', minHeight: 32 }} value={width} onChange={(e) => updateAttributes({ width: Number(e.target.value) })}>
              {[25, 33, 50, 66, 75, 100].map((w) => (
                <option key={w} value={w}>
                  {w}%
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-sm" onClick={() => deleteNode()}>
              <Trash2 size={14} aria-hidden /> Excluir
            </button>
          </div>
          <input className="input" placeholder="Texto alternativo (acessibilidade)" aria-label="Texto alternativo" value={alt} onChange={(e) => updateAttributes({ alt: e.target.value })} />
          <input className="input" placeholder="Legenda (opcional)" aria-label="Legenda da imagem" value={caption} onChange={(e) => updateAttributes({ caption: e.target.value })} />
        </div>
      ) : (
        caption && <figcaption>{caption}</figcaption>
      )}
    </NodeViewWrapper>
  );
}

export function AttachmentView({ node, editor, deleteNode }: NodeViewProps) {
  const { fileId, name, size, mime } = node.attrs as { fileId: string; name: string; size: number | null; mime: string | null };
  const Icon = mime?.startsWith('image/') ? ImageIcon : mime?.startsWith('video/') ? VideoIcon : FileText;
  return (
    <NodeViewWrapper data-attachment="">
      <div className="row" style={{ gap: 8 }} contentEditable={false}>
        <a className="attachment-card" href={`/api/files/${fileId}?download=1`} download={name} onClick={(e) => editor.isEditable && e.preventDefault()}>
          <span className="att-icon" aria-hidden>
            <Icon size={18} />
          </span>
          <span style={{ minWidth: 0, flex: 1 }}>
            <span className="att-name">{name}</span>
            <span className="att-size">{size ? formatBytes(size) : 'Anexo'}</span>
          </span>
          <Download size={18} aria-hidden />
        </a>
        {editor.isEditable && (
          <button type="button" className="btn btn-sm btn-icon" aria-label="Remover anexo" onClick={() => deleteNode()}>
            <Trash2 size={14} aria-hidden />
          </button>
        )}
      </div>
    </NodeViewWrapper>
  );
}
