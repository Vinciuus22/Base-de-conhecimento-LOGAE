import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { X, ExternalLink } from 'lucide-react';
import { youTubeEmbedUrl, youTubeWatchUrl } from '@shared/youtube';

export type MediaItem =
  | { kind: 'youtube'; youtubeId: string; start?: number | null; title?: string }
  | { kind: 'upload'; src: string; poster?: string | null; title?: string }
  | { kind: 'image'; src: string; alt?: string };

interface MediaCtx {
  open: (item: MediaItem) => void;
}

const Ctx = createContext<MediaCtx>({ open: () => undefined });
export const useMedia = () => useContext(Ctx);

/**
 * Player ampliado (modal) para vídeos do YouTube e vídeos enviados, e lightbox de
 * imagens. Fecha com Esc, clique fora ou botão "Fechar"; o foco retorna ao
 * elemento que abriu o player para continuar a leitura.
 */
export function MediaProvider({ children }: { children: ReactNode }) {
  const [item, setItem] = useState<MediaItem | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const open = useCallback((next: MediaItem) => {
    returnFocus.current = document.activeElement as HTMLElement | null;
    setItem(next);
  }, []);
  const close = useCallback(() => {
    setItem(null);
    setTimeout(() => returnFocus.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [item, close]);

  return (
    <Ctx.Provider value={{ open }}>
      {children}
      {item && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && close()}>
          {item.kind === 'image' ? (
            <div className="lightbox" role="dialog" aria-modal="true" aria-label={item.alt || 'Imagem ampliada'}>
              <div className="video-modal-bar" style={{ borderRadius: '10px 10px 0 0' }}>
                <span>{item.alt || 'Imagem'}</span>
                <button ref={closeRef} type="button" className="btn btn-sm" onClick={close}>
                  <X size={16} aria-hidden /> Fechar
                </button>
              </div>
              <img src={item.src} alt={item.alt ?? ''} />
            </div>
          ) : (
            <div className="video-modal" role="dialog" aria-modal="true" aria-label={item.title || 'Reprodução de vídeo'}>
              <div className="video-modal-bar">
                <span>{item.title || 'Vídeo'}</span>
                <div className="row" style={{ gap: 4 }}>
                  {item.kind === 'youtube' && (
                    <a className="btn btn-sm" href={youTubeWatchUrl(item.youtubeId)} target="_blank" rel="noopener noreferrer">
                      <ExternalLink size={14} aria-hidden /> Abrir no YouTube
                    </a>
                  )}
                  <button ref={closeRef} type="button" className="btn btn-sm" onClick={close} aria-label="Fechar o vídeo e voltar ao artigo">
                    <X size={16} aria-hidden /> Fechar
                  </button>
                </div>
              </div>
              <div className="video-frame">
                {item.kind === 'youtube' ? (
                  <iframe
                    src={youTubeEmbedUrl(item.youtubeId, { autoplay: true, start: item.start ?? null })}
                    title={item.title || 'Vídeo do YouTube'}
                    allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                    allowFullScreen
                    referrerPolicy="strict-origin-when-cross-origin"
                  />
                ) : (
                  // Controles nativos: reprodução, pausa, volume e tela cheia.
                  <video src={item.src} poster={item.poster ?? undefined} controls autoPlay playsInline preload="metadata">
                    Seu navegador não suporta a reprodução deste vídeo.
                  </video>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </Ctx.Provider>
  );
}
