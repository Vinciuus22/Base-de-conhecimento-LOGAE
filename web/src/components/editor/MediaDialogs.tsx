import { useState } from 'react';
import { Link2, Upload as UploadIcon, Youtube } from 'lucide-react';
import { parseYouTubeStart, parseYouTubeUrl, youTubeThumbnailUrl } from '@shared/youtube';
import { IMAGE_MIME_TYPES, VIDEO_MIME_TYPES, formatBytes } from '@shared/uploads';
import { upload, errorMessage } from '../../lib/api';
import type { UploadedFile } from '../../lib/types';
import { useAuth } from '../../context/AuthContext';
import { Alert, Button, Field, Modal } from '../ui';
import type { VideoAttrs } from '../content/extensions';

/** Envia um arquivo de mídia para o servidor (validação real ocorre no backend). */
export async function uploadMedia(file: File, onProgress?: (p: number) => void): Promise<{ file: UploadedFile; warning: string | null }> {
  const form = new FormData();
  form.append('file', file);
  return upload<{ file: UploadedFile; warning: string | null }>('/api/files', form, onProgress);
}

export function checkFileClientSide(file: File, kind: 'image' | 'video' | 'attachment', limits: { maxImageMb: number; maxVideoMb: number; maxAttachmentMb: number }): string | null {
  if (kind === 'image' && !(IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) return 'Formato de imagem não permitido. Use PNG, JPG, WEBP ou GIF.';
  if (kind === 'video' && !(VIDEO_MIME_TYPES as readonly string[]).includes(file.type)) return 'Formato de vídeo não permitido. Use MP4, WEBM ou MOV.';
  const max = (kind === 'image' ? limits.maxImageMb : kind === 'video' ? limits.maxVideoMb : limits.maxAttachmentMb) * 1024 * 1024;
  if (file.size > max) return `O arquivo excede o limite de ${formatBytes(max)}.`;
  return null;
}

export function LinkDialog({ initial, onSubmit, onRemove, onClose }: { initial: string; onSubmit: (href: string) => void; onRemove: () => void; onClose: () => void }) {
  const [href, setHref] = useState(initial);
  const valid = /^(https?:\/\/[^\s]+|mailto:[^\s]+|\/(?!\/)[^\s]*|#[\w-]+)$/i.test(href.trim());
  return (
    <Modal
      title="Inserir link"
      onClose={onClose}
      footer={
        <>
          {initial && (
            <Button onClick={onRemove} variant="danger">
              Remover link
            </Button>
          )}
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" disabled={!valid} onClick={() => onSubmit(href.trim())}>
            Aplicar
          </Button>
        </>
      }
    >
      <Field label="Endereço" htmlFor="link-href" hint="Use https://, mailto: ou um caminho interno iniciado por /." error={href && !valid ? 'Endereço inválido.' : undefined}>
        <input id="link-href" className="input" value={href} onChange={(e) => setHref(e.target.value)} placeholder="https://" />
      </Field>
    </Modal>
  );
}

export function VideoDialog({ onInsert, onClose }: { onInsert: (attrs: VideoAttrs) => void; onClose: () => void }) {
  const { config } = useAuth();
  const [tab, setTab] = useState<'youtube' | 'upload'>('youtube');
  const [url, setUrl] = useState('');
  const [caption, setCaption] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const youtubeId = parseYouTubeUrl(url);

  const submit = async () => {
    setError(null);
    if (tab === 'youtube') {
      if (!youtubeId) return setError('Link do YouTube inválido. Use um endereço de youtube.com ou youtu.be.');
      onInsert({ provider: 'youtube', youtubeId, start: parseYouTubeStart(url), caption });
      return;
    }
    if (!file) return setError('Selecione o arquivo de vídeo.');
    const problem = config && checkFileClientSide(file, 'video', config.uploads);
    if (problem) return setError(problem);
    try {
      setProgress(0);
      const res = await uploadMedia(file, setProgress);
      if (res.warning) setWarning(res.warning);
      onInsert({ provider: 'upload', fileId: res.file.id, posterId: null, caption });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setProgress(null);
    }
  };

  return (
    <Modal
      title="Inserir vídeo"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={submit} loading={progress !== null} disabled={tab === 'youtube' ? !youtubeId : !file}>
            Inserir vídeo
          </Button>
        </>
      }
    >
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'youtube'} onClick={() => setTab('youtube')}>
          <Youtube size={16} aria-hidden style={{ verticalAlign: 'middle' }} /> Link do YouTube
        </button>
        <button type="button" role="tab" aria-selected={tab === 'upload'} onClick={() => setTab('upload')}>
          <UploadIcon size={16} aria-hidden style={{ verticalAlign: 'middle' }} /> Enviar arquivo
        </button>
      </div>
      <div className="stack">
        {tab === 'youtube' ? (
          <>
            <Field label="Link do vídeo" htmlFor="yt-url" hint="Aceita links padrão (youtube.com/watch?v=…), curtos (youtu.be/…), shorts e embed." error={url && !youtubeId ? 'Link inválido ou de domínio não permitido.' : undefined}>
              <input id="yt-url" className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://youtu.be/…" />
            </Field>
            {youtubeId && (
              <div>
                <span className="small muted">Pré-visualização da miniatura:</span>
                <img src={youTubeThumbnailUrl(youtubeId)} alt="Miniatura do vídeo" style={{ width: '100%', borderRadius: 8, marginTop: 6 }} />
              </div>
            )}
          </>
        ) : (
          <>
            <Field label="Arquivo de vídeo" htmlFor="vid-file" hint={`MP4, WEBM ou MOV, até ${config?.uploads.maxVideoMb ?? '-'} MB. A miniatura é gerada automaticamente; você poderá enviar uma capa depois.`}>
              <input id="vid-file" type="file" className="input" accept="video/mp4,video/webm,video/quicktime" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Field>
            {progress !== null && (
              <div role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} className="small muted">
                Enviando… {progress}%
              </div>
            )}
          </>
        )}
        <Field label="Legenda (opcional)" htmlFor="vid-caption">
          <input id="vid-caption" className="input" value={caption} onChange={(e) => setCaption(e.target.value)} />
        </Field>
        {warning && <Alert kind="warning">{warning}</Alert>}
        {error && <Alert kind="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}

export function LinkIcon() {
  return <Link2 size={16} aria-hidden />;
}
