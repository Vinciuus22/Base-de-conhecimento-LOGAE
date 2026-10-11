import { Lock } from 'lucide-react';
import { buildLockMessage } from '@shared/domain';
import { formatDate, formatTime } from '../lib/format';
import type { LockState } from '../lib/types';

/** Mensagem de bloqueio com os dados reais do responsável (nome, data e hora de início). */
export function LockBanner({ lock }: { lock: LockState }) {
  if (!lock.locked || !lock.holder || !lock.acquiredAt) return null;
  const text = lock.mine
    ? `Você está editando este artigo em outra sessão (aba ou dispositivo) desde ${formatDate(lock.acquiredAt)} às ${formatTime(lock.acquiredAt)}. Conclua ou cancele a edição na outra sessão; se ela foi fechada, o bloqueio expira automaticamente em instantes.`
    : buildLockMessage(lock.holder.name, formatDate(lock.acquiredAt), formatTime(lock.acquiredAt));
  return (
    <div className="alert alert-warning lock-banner" role="status" data-testid="lock-banner">
      <Lock size={18} aria-hidden />
      <div>{text}</div>
    </div>
  );
}
