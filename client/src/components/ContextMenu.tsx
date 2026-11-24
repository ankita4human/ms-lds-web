import { useEffect } from 'react';

export type MenuItem = { key: string; label: string; icon: string; enabled: boolean; sepBefore?: boolean };

export default function ContextMenu({ x, y, items, onPick, onClose }: {
  x: number; y: number; items: MenuItem[]; onPick: (key: string) => void; onClose: () => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('click', close); window.addEventListener('scroll', close, true); window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', close, true); window.removeEventListener('keydown', esc); };
  }, [onClose]);
  // Keep the menu inside the viewport.
  const left = Math.min(x, window.innerWidth - 250), top = Math.min(y, window.innerHeight - items.length * 36 - 20);
  return (
    <div className="ctx" style={{ left, top }} onClick={e => e.stopPropagation()} onContextMenu={e => e.preventDefault()}>
      {items.map(i => (
        <div key={i.key}>
          {i.sepBefore && <div className="sep" />}
          <button disabled={!i.enabled} onClick={() => { onPick(i.key); onClose(); }}><span className="ci">{i.icon}</span>{i.label}</button>
        </div>
      ))}
    </div>
  );
}
