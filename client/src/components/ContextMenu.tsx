import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

export type MenuItem = { key: string; label: string; icon: string; enabled: boolean; sepBefore?: boolean; hint?: string };

const DANGER = new Set(['delete', 'block', 'wfremove', 'remove', 'del']);

/** Right-click menu: header with the object name, tinted icon tiles, danger entries in red, keyboard control (↑ ↓ Enter Esc), opens upwards / leftwards when near the screen edge. */
export default function ContextMenu({ x, y, items, onPick, onClose, title, subtitle }: {
  x: number; y: number; items: MenuItem[]; onPick: (key: string) => void; onClose: () => void; title?: string; subtitle?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const enabled = useMemo(() => items.map((i, n) => (i.enabled ? n : -1)).filter(n => n >= 0), [items]);
  const [act, setAct] = useState(-1);

  useEffect(() => {
    const close = () => onClose();
    // scrolling the menu itself must not close it; scrolling anything else (the page, the table) does
    const onScroll = (e: Event) => { const t = e.target as Node | null; if (t && box.current && (t === box.current || box.current.contains(t))) return; onClose(); };
    window.addEventListener('click', close); window.addEventListener('scroll', onScroll, true); window.addEventListener('resize', close);
    return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', close); };
  }, [onClose]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); if (!enabled.length) return;
        const at = enabled.indexOf(act);
        setAct(enabled[e.key === 'ArrowDown' ? (at + 1) % enabled.length : (at <= 0 ? enabled.length - 1 : at - 1)]!);
      } else if (e.key === 'Enter' && act >= 0) { e.preventDefault(); const it = items[act]; if (it?.enabled) { onPick(it.key); onClose(); } }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [act, enabled, items, onPick, onClose]);

  // Keep the menu inside the viewport (measured, so any number of items works).
  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect(); if (!r) return;
    const m = 8;
    setPos({ left: Math.max(m, Math.min(x, window.innerWidth - r.width - m)), top: Math.max(m, y + r.height + m > window.innerHeight ? window.innerHeight - r.height - m : y) });
  }, [x, y, items.length]);
  useEffect(() => { box.current?.querySelector('.act')?.scrollIntoView({ block: 'nearest' }); }, [act]);

  return (
    <div className="ctx" ref={box} style={{ left: pos.left, top: pos.top }} role="menu" onClick={e => e.stopPropagation()} onContextMenu={e => e.preventDefault()}>
      {title && <div className="ctx-head"><b title={title}>{title}</b>{subtitle && <small>{subtitle}</small>}</div>}
      <div className="ctx-body">
        {items.map((i, n) => (
          <div key={i.key}>
            {i.sepBefore && <div className="sep" />}
            <button role="menuitem" disabled={!i.enabled} className={`${DANGER.has(i.key) ? 'danger' : ''} ${act === n ? 'act' : ''}`} style={{ animationDelay: `${Math.min(n, 14) * 14}ms` }}
              onMouseEnter={() => i.enabled && setAct(n)} onClick={() => { onPick(i.key); onClose(); }}>
              <span className="ci">{i.icon}</span><span className="cl">{i.label}</span>{i.hint && <kbd>{i.hint}</kbd>}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
