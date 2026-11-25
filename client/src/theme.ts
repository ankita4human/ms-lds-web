export type ThemeMode = 'normal' | 'light' | 'dark' | 'night' | 'navy';
const KEY = 'pl_theme';
export const getTheme = (): ThemeMode => {
  try { const v = localStorage.getItem(KEY); if (v === 'light' || v === 'dark' || v === 'night' || v === 'navy' || v === 'normal') return v; } catch { /* storage blocked */ }
  return 'normal';
};
export function applyTheme(m: ThemeMode) {
  document.documentElement.setAttribute('data-theme', m);
  try { localStorage.setItem(KEY, m); } catch { /* storage blocked */ }
}
applyTheme(getTheme());
