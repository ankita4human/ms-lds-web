import { useEffect, useRef, useState } from 'react';
import { UI_LANGS, useI18n } from '../i18n';
import './uilang.css';

/** Interface language picker (DE, EN, ZH, PL, ES): used on the login page and in the middle of the header. */
export default function UiLangSwitch({ variant = 'header' }: { variant?: 'header' | 'login' }) {
  const { ui, setUi, t } = useI18n();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const cur = UI_LANGS.find(l => l.code === ui)!;
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', away); window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', away); window.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className={`uil uil-${variant}`} ref={box}>
      <button type="button" className="uil-btn" onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open}
        title={t('head.uiLang')} aria-label={`${t('head.uiLang')}: ${cur.name}`}>
        <span className="uil-globe" aria-hidden>🌐</span>
        <span className="uil-cur"><b>{cur.code}</b><small>{cur.name}</small></span>
        <span className="uil-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <ul className="uil-menu" role="listbox" aria-label={t('head.uiLang')}>
          {UI_LANGS.map(l => (
            <li key={l.code} role="option" aria-selected={l.code === ui}>
              <button type="button" className={l.code === ui ? 'on' : ''} onClick={() => { setUi(l.code); setOpen(false); }}>
                <span className="uil-flag" aria-hidden>{l.flag}</span><span className="uil-name">{l.name}</span><em>{l.code}</em>
                {l.code === ui && <span className="uil-tick" aria-hidden>✓</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
