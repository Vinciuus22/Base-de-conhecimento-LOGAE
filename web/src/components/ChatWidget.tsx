import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bot, FileText, MessageCircle, Newspaper, RotateCcw, Send, Ticket, X } from 'lucide-react';
import { post, errorMessage } from '../lib/api';
import type { ChatMessage } from '../lib/types';
import { useAuth } from '../context/AuthContext';

interface ChatResponse {
  conversationId: string;
  conversationToken?: string;
  message: ChatMessage;
  offerTicket: boolean;
  ticketDraft: { title: string; description: string };
}

const STORAGE_KEY = 'kb-chat';

function loadState(): { conversationId?: string; token?: string; messages: ChatMessage[] } {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '') as { conversationId?: string; token?: string; messages: ChatMessage[] };
  } catch {
    return { messages: [] };
  }
}

/** Chat com IA (ambientes interno e externo). As fontes são definidas pelo backend conforme as permissões. */
export function ChatWidget() {
  const { user, config } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState(loadState);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offer, setOffer] = useState<ChatResponse['ticketDraft'] | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const userKey = user?.id ?? 'anon';
  const lastUser = useRef(userKey);

  // Ao entrar ou sair, a conversa é reiniciada (o público das fontes muda).
  useEffect(() => {
    if (lastUser.current !== userKey) {
      lastUser.current = userKey;
      setState({ messages: [] });
      setOffer(null);
    }
  }, [userKey]);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* armazenamento indisponível */
    }
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [state, busy]);

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener('kb-open-chat', handler);
    return () => window.removeEventListener('kb-open-chat', handler);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (config && !config.anonymousAccess && !user) return null;

  const send = async () => {
    const message = input.trim();
    if (message.length < 2 || busy) return;
    setInput('');
    setError(null);
    setOffer(null);
    const userMsg: ChatMessage = { id: `local-${Date.now()}`, role: 'user', text: message };
    setState((s) => ({ ...s, messages: [...s.messages, userMsg] }));
    setBusy(true);
    try {
      const res = await post<ChatResponse>('/api/chat', { message, conversationId: state.conversationId, conversationToken: state.token });
      setState((s) => ({
        conversationId: res.conversationId,
        token: res.conversationToken ?? (res.conversationId === s.conversationId ? s.token : undefined),
        messages: [...s.messages, { ...res.message, role: 'assistant' }],
      }));
      if (res.offerTicket) setOffer(res.ticketDraft);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const openTicket = () => {
    if (!offer) return;
    setOpen(false);
    // O formulário é apenas PRÉ-PREENCHIDO; o usuário revisa e confirma o envio.
    navigate('/tickets/novo', { state: { draft: offer, fromChat: true } });
  };

  if (!open) {
    return (
      <button type="button" className="btn btn-primary chat-launcher" onClick={() => setOpen(true)} aria-label="Abrir o assistente virtual">
        <MessageCircle size={20} aria-hidden /> Assistente
      </button>
    );
  }

  return (
    <section className="chat-panel" aria-label="Assistente virtual">
      <div className="chat-head">
        <Bot size={20} aria-hidden />
        <div style={{ flex: 1 }}>
          <strong>Assistente virtual</strong>
          <div className="tiny" style={{ opacity: 0.85 }}>
            {user?.userType === 'internal' ? 'Consulta artigos internos e externos autorizados' : 'Consulta a Base de Conhecimento pública'}
          </div>
        </div>
        <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label="Nova conversa" title="Nova conversa" onClick={() => (setState({ messages: [] }), setOffer(null))}>
          <RotateCcw size={16} aria-hidden />
        </button>
        <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label="Fechar assistente" onClick={() => setOpen(false)}>
          <X size={18} aria-hidden />
        </button>
      </div>
      <div className="chat-messages" ref={listRef} aria-live="polite">
        {state.messages.length === 0 && (
          <div className="chat-msg assistant">
            Olá! Descreva sua dúvida ou o problema que está enfrentando. Vou procurar a resposta na Base de Conhecimento e indicar as fontes.
            {config && !config.ai.generative && (
              <div className="tiny muted" style={{ marginTop: 6 }}>
                Modo de consulta: exibo os trechos encontrados nos artigos (IA generativa não configurada).
              </div>
            )}
          </div>
        )}
        {state.messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="chat-msg user">
              {m.text}
            </div>
          ) : (
            <div key={m.id} className="chat-msg assistant">
              <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
              {m.steps && m.steps.length > 0 && (
                <ol>
                  {m.steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              )}
              {m.followUpQuestion && <p className="small" style={{ marginTop: 8 }}><em>{m.followUpQuestion}</em></p>}
              {m.sources && m.sources.length > 0 && (
                <div className="chat-sources">
                  <span className="tiny muted">Fontes consultadas:</span>
                  {m.sources.map((s) => (
                    <Link key={s.id} to={s.url} className="chat-source" onClick={() => window.innerWidth < 720 && setOpen(false)}>
                      <strong>
                        {s.type === 'article' ? <Newspaper size={14} aria-hidden /> : <FileText size={14} aria-hidden />}
                        {s.title}
                      </strong>
                      <blockquote>“{s.excerpt}”</blockquote>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          ),
        )}
        {busy && (
          <div className="chat-msg assistant typing" aria-label="O assistente está respondendo">
            <span />
            <span />
            <span />
          </div>
        )}
        {offer && (
          <div className="chat-msg assistant">
            <p style={{ margin: '0 0 8px' }}>Deseja que a equipe de suporte analise? Você poderá revisar os dados antes de enviar.</p>
            <button type="button" className="btn btn-sm btn-primary" onClick={openTicket}>
              <Ticket size={14} aria-hidden /> Abrir ticket
            </button>
          </div>
        )}
        {error && (
          <div className="alert alert-danger small" role="alert">
            {error}
          </div>
        )}
      </div>
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label htmlFor="chat-text" className="sr-only">
          Sua pergunta
        </label>
        <textarea
          id="chat-text"
          ref={inputRef}
          className="textarea"
          placeholder="Digite sua pergunta…"
          value={input}
          maxLength={2000}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button type="submit" className="btn btn-primary btn-icon" style={{ alignSelf: 'flex-end', height: 44, width: 44 }} disabled={busy || input.trim().length < 2} aria-label="Enviar pergunta">
          <Send size={18} aria-hidden />
        </button>
      </form>
    </section>
  );
}

export function openChat() {
  window.dispatchEvent(new Event('kb-open-chat'));
}
