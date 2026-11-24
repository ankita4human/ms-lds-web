import { useEffect, useState } from 'react';

export type ToastMsg = { ok: boolean; t: string } | null;

/** Centered, animated message dialog. Success closes itself after a few seconds (OK also closes); errors stay until closed.
 *  Pass a NEW object for every message. */
export default function Toast({ msg, onClose, ms = 3500 }: { msg: ToastMsg; onClose: () => void; ms?: number }) {
  const [shown, setShown] = useState<ToastMsg>(null);
  useEffect(() => {
    setShown(msg);
    if (!msg || !msg.ok) return;
    const t = setTimeout(onClose, ms);
    return () => clearTimeout(t);
  }, [msg]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!shown) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === 'Enter') onClose(); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!shown) return null;
  const ok = shown.ok;
  return (
    <div className="msg-back" onMouseDown={onClose}>
      <div className={`msgbox ${ok ? 'ok' : 'bad'}`} role="alertdialog" aria-modal="true" aria-live="assertive" onMouseDown={e => e.stopPropagation()}>
        <span className="mb-ring" aria-hidden />
        <span className="mb-ico" aria-hidden>{ok
          ? <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path className="mb-tick" d="M5 12.5l4.5 4.5L19 7.5" /></svg>
          : <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M12 5.5v8M12 18v.5" /></svg>}</span>
        <h3>{ok ? 'Success' : 'Something went wrong'}</h3>
        <p>{shown.t}</p>
        <button className="mb-ok" onClick={onClose} autoFocus>{ok ? 'OK' : 'Close'}</button>
        {ok && <i className="mb-bar" style={{ animationDuration: `${ms}ms` }} />}
      </div>
    </div>
  );
}
