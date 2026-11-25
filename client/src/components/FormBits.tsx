import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Spinner } from './Loader';

/** Toggle switch with an optional description line. */
export function Switch({ checked, onChange, disabled, label, desc }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: ReactNode; desc?: ReactNode }) {
  return (
    <label className={`fx-switch ${disabled ? 'off' : ''}`}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      <span className="trk"><i /></span>
      <span className="tx"><b>{label}</b>{desc && <small>{desc}</small>}</span>
    </label>
  );
}

/** Multi-select as toggle pills (with a small search when the list is long). */
export function Pills({ options, value, onChange, disabled, label }: { options: { id: number; name: string }[]; value: number[]; onChange: (v: number[]) => void; disabled?: boolean; label: string }) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => options.filter(o => o.name.toLowerCase().includes(q.trim().toLowerCase())), [options, q]);
  const toggle = (id: number) => onChange(value.includes(id) ? value.filter(x => x !== id) : [...value, id]);
  return (
    <div className="fx-field">
      <div className="fx-lbl">{label}<span className="fx-lbl-tools">
        {value.length > 0 && <em>{value.length} selected</em>}
        <button type="button" disabled={disabled} onClick={() => onChange(options.map(o => o.id))}>All</button>
        <button type="button" disabled={disabled || value.length === 0} onClick={() => onChange([])}>None</button></span></div>
      {options.length > 8 && <input className="fx-mini" placeholder={`Find in ${label.toLowerCase()}…`} value={q} onChange={e => setQ(e.target.value)} disabled={disabled} />}
      <div className="fx-pills" role="group" aria-label={label}>
        {shown.map(o => <button type="button" key={o.id} className={value.includes(o.id) ? 'on' : ''} aria-pressed={value.includes(o.id)} disabled={disabled} onClick={() => toggle(o.id)}>{value.includes(o.id) && <span aria-hidden="true">✓ </span>}{o.name}</button>)}
        {shown.length === 0 && <span className="fx-none">Nothing matches.</span>}
      </div>
    </div>
  );
}

/** Searchable single choice: type to filter, pick from the suggestions, × clears. */
export function Combo({ label, options, value, onChange, disabled, placeholder }: { label: string; options: { id: number; name: string }[]; value?: number; onChange: (v?: number) => void; disabled?: boolean; placeholder?: string }) {
  const listId = useId();
  const cur = options.find(o => o.id === value)?.name ?? '';
  const [txt, setTxt] = useState(cur);
  useEffect(() => setTxt(cur), [cur]);
  const commit = (t: string) => { const m = options.find(o => o.name.toLowerCase() === t.trim().toLowerCase()); if (m) onChange(m.id); else if (!t.trim()) onChange(undefined); else setTxt(cur); };
  return (
    <div className="fx-field">
      <div className="fx-lbl">{label}</div>
      <div className={`fx-combo ${value ? 'set' : ''}`}>
        <input list={listId} value={txt} disabled={disabled} placeholder={placeholder ?? 'Any'} onChange={e => { setTxt(e.target.value); const m = options.find(o => o.name === e.target.value); if (m) onChange(m.id); }} onBlur={e => commit(e.target.value)} />
        {value !== undefined && !disabled && <button type="button" aria-label={`Clear ${label}`} onClick={() => { onChange(undefined); setTxt(''); }}>×</button>}
        <datalist id={listId}>{options.map(o => <option key={o.id} value={o.name} />)}</datalist>
      </div>
    </div>
  );
}

/** Sticks to the bottom of the editor: shows unsaved changes and the main actions. */
export function SaveBar({ dirty, busy, canSave, onSave, onReset, children }: { dirty: boolean; busy: boolean; canSave: boolean; onSave: () => void; onReset: () => void; children?: ReactNode }) {
  return (
    <div className={`fx-savebar ${dirty ? 'dirty' : ''}`}>
      <span className="st">{dirty ? <><i className="dot" />Unsaved changes</> : <><span className="okmark">✓</span>All changes saved</>}</span>
      <span className="act">
        {children}
        <button className="btn-ghost" onClick={onReset} disabled={busy || !dirty}>Discard</button>
        <button className="btn-primary" onClick={onSave} disabled={busy || !canSave || !dirty}>{busy ? <Spinner /> : <>Save <kbd>Ctrl+S</kbd></>}</button>
      </span>
    </div>
  );
}

/** Ctrl+S / Cmd+S runs `fn` while `on` is true. */
export function useSaveShortcut(fn: () => void, on: boolean) {
  useEffect(() => {
    if (!on) return;
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); fn(); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  });
}

/** Stable colour for a name (list badges). */
export const hue = (s: string) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
