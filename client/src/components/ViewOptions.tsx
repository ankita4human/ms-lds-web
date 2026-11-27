import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_PREFS, FONTS, GRID_COLUMNS, fmtStamp, getPrefs, setPrefs, type ViewPrefs } from '../viewPrefs';
import './viewopts.css';

const same = (a: ViewPrefs, b: ViewPrefs) => a.font === b.font && a.size === b.size && a.dateOnly === b.dateOnly && [...a.hidden].sort().join() === [...b.hidden].sort().join();
const DESC: Record<string, string> = {
  fonts: 'Choose the font and size of the folder tree and the document grid. “Default” goes back to the standard look.',
  date: 'Switch on to show only the date in the grid. Switch off to show the date and the time.',
  cols: 'Click the checkbox for every column, which should be viewable or hidden.',
};

/** Program options > View tab (manual p. 33). Changes are applied with OK; Cancel puts back what was saved. */
export default function ViewOptions({ onDone }: { onDone: (msg: string) => void }) {
  const [saved, setSaved] = useState<ViewPrefs>(getPrefs);
  const [p, setP] = useState<ViewPrefs>(saved);
  const [picker, setPicker] = useState(false);
  const [hint, setHint] = useState('cols');
  const dirty = !same(p, saved);
  const sample = useMemo(() => fmtStamp(new Date().toISOString(), p.dateOnly), [p.dateOnly]);
  const shownFont = p.font || 'Default';
  const style = { fontFamily: p.font ? `"${p.font}", system-ui, sans-serif` : undefined, fontSize: p.size > 0 ? `${p.size}pt` : undefined };
  const toggle = (k: string) => setP(x => ({ ...x, hidden: x.hidden.includes(k) ? x.hidden.filter(h => h !== k) : [...x.hidden, k] }));
  const allShown = p.hidden.length === 0;
  useEffect(() => { if (!picker) return; const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setPicker(false); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [picker]);

  return (
    <div className="vo">
      <section className="vo-box" onMouseEnter={() => setHint('fonts')}>
        <h4>Fonts</h4>
        <div className="vo-row">
          <span className="vo-l">Tree and Grid</span>
          <span className="vo-font" style={style} title="Font used by the folder tree and the grid">{shownFont}</span>
          <span className="vo-size" aria-label="Font size">
            <input type="number" min={7} max={24} value={p.size > 0 ? p.size : 10} onChange={e => setP({ ...p, size: Math.max(7, Math.min(24, Number(e.target.value) || 10)) })} />
            <span>pt</span>
          </span>
          <button className="vo-btn primary" onClick={() => setPicker(true)}>Select font</button>
          <button className="vo-btn" onClick={() => setP({ ...p, font: '', size: 0 })}>Default</button>
        </div>
        <div className="vo-row" onMouseEnter={() => setHint('date')}>
          <label className="vo-chk"><input type="checkbox" checked={p.dateOnly} onChange={e => setP({ ...p, dateOnly: e.target.checked })} /><span>Show Date Only</span></label>
          <span className="vo-fmt">[dd/mm/yyyy]</span><span className="vo-fmt">[hh:mm]</span>
          <span className="vo-sample">e.g. <b>{sample}</b></span>
        </div>
        <div className="vo-preview" style={style}><b>Preview</b> — ID 478 · MIND Excel · Blocked · Übersicht · 0.0.4 · {fmtStamp('2026-11-24T14:17:00', p.dateOnly)}</div>
      </section>

      <div className="vo-split">
        <section className="vo-box vo-cols" onMouseEnter={() => setHint('cols')}>
          <h4>Grid Columns</h4>
          <div className="vo-collist">
            {GRID_COLUMNS.map(c => (
              <label key={c.k} className={`vo-col${p.hidden.includes(c.k) ? ' off' : ''}`} title={c.locked ? 'The document name is always shown' : undefined}>
                <input type="checkbox" checked={!p.hidden.includes(c.k)} disabled={c.locked} onChange={() => toggle(c.k)} /><span>{c.label}</span>
              </label>))}
          </div>
          <button className="vo-btn" onClick={() => setP({ ...p, hidden: [] })} disabled={allShown}>Select all</button>
        </section>
        <section className="vo-box vo-desc"><h4>Description</h4><p>{DESC[hint]}</p>
          <small>{GRID_COLUMNS.length - p.hidden.length} of {GRID_COLUMNS.length} columns shown</small></section>
      </div>

      <div className="vo-foot">
        {dirty && <span className="vo-dirty">● Unsaved changes</span>}
        <button className="vo-btn" onClick={() => { setP(saved); }} disabled={!dirty}>Cancel</button>
        <button className="vo-btn ok" disabled={!dirty} onClick={() => { setPrefs(p); setSaved(p); onDone('View options saved. The folder tree and the document grid use them now.'); }}>OK</button>
        <button className="vo-btn" onClick={() => { setPrefs(DEFAULT_PREFS); setSaved(DEFAULT_PREFS); setP(DEFAULT_PREFS); onDone('View options reset to the standard look.'); }}>Reset all</button>
      </div>

      {picker && (
        <div className="modal-back" onMouseDown={() => setPicker(false)}>
          <div className="modal vo-pick" role="dialog" aria-label="Select font" onMouseDown={e => e.stopPropagation()}>
            <div className="vo-pick-head"><h3>Select font</h3><button className="x" onClick={() => setPicker(false)} aria-label="Close">✕</button></div>
            <div className="vo-pick-list" role="listbox">
              {FONTS.map(f => (
                <button key={f} role="option" aria-selected={p.font === f} className={p.font === f ? 'on' : ''} onClick={() => { setP({ ...p, font: f, size: p.size || 10 }); setPicker(false); }}>
                  <span style={{ fontFamily: `"${f}", sans-serif` }}>{f}</span><small style={{ fontFamily: `"${f}", sans-serif` }}>AaBbCc 0123 ÄÖÜ</small>
                </button>))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
