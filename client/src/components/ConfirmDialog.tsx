import { useEffect, useRef } from 'react';
import { Spinner } from './Loader';

/** Modern confirmation dialog used instead of the browser's confirm() everywhere. */
export default function ConfirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, busy = false, onConfirm, onCancel }: {
  title: string; message: React.ReactNode; confirmLabel?: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ok.current?.focus();
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [busy, onCancel]);
  return (
    <div className="modal-back" style={{ zIndex: 90 }} onMouseDown={() => !busy && onCancel()}>
      <div className="modal confirm" role="alertdialog" aria-modal="true" aria-label={title} onMouseDown={e => e.stopPropagation()}>
        <div className={`confirm-ico ${danger ? 'danger' : ''}`} aria-hidden="true">{danger ? '🗑️' : '❓'}</div>
        <h3>{title}</h3>
        <div className="confirm-msg">{message}</div>
        <div className="modal-foot" style={{ justifyContent: 'center' }}>
          <button className="btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button ref={ok} className={`btn-primary ${danger ? 'btn-danger' : ''}`} onClick={onConfirm} disabled={busy}>{busy ? <><Spinner />Please wait</> : confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
