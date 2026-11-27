import { useState } from 'react';
import { applySkin, getSkin, type SkinMode } from '../skin';
import { tr } from '../i18n';

const OPTS: { id: SkinMode; label: string; title: string }[] = [
  { id: 'classic', label: 'Classic', title: 'Current design' },
  { id: 'soft', label: 'Soft UI', title: 'New soft theme' },
];

/** Switches the whole application between the current design (Classic) and the new soft design (Soft UI); independent of Normal / Light / Dark. */
export default function SkinSwitch() {
  const [mode, setMode] = useState<SkinMode>(getSkin());
  const pick = (m: SkinMode) => { applySkin(m); setMode(m); };
  return (
    <div className="skin-sw" role="radiogroup" aria-label={tr('Design')}>
      {OPTS.map(o => <button key={o.id} role="radio" aria-checked={mode === o.id} className={mode === o.id ? 'on' : ''} title={o.title} onClick={() => pick(o.id)}>{o.label}</button>)}
    </div>
  );
}
