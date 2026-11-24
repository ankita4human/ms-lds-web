import { useState } from 'react';
import { applyTheme, getTheme, type ThemeMode } from '../theme';

const ICON: Record<ThemeMode, JSX.Element> = {
  normal: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 3v18" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" /></svg>,
  light: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>,
  dark: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>,
};
const LABEL: Record<ThemeMode, string> = { normal: 'Normal (as is)', light: 'Light', dark: 'Dark' };

/** Three-way theme switch (Normal = the existing look, Light, Dark); the choice is kept per browser. */
export default function ThemeSwitch() {
  const [mode, setMode] = useState<ThemeMode>(getTheme());
  const pick = (m: ThemeMode) => { applyTheme(m); setMode(m); };
  return (
    <div className="theme-sw" role="radiogroup" aria-label="Theme">
      {(['normal', 'light', 'dark'] as ThemeMode[]).map(m => (
        <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? 'on' : ''} title={LABEL[m]} aria-label={LABEL[m]} onClick={() => pick(m)}>{ICON[m]}</button>
      ))}
    </div>
  );
}
