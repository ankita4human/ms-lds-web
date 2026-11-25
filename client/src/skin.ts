export type SkinMode = 'classic' | 'soft';
const KEY = 'pl_skin';
export const getSkin = (): SkinMode => {
  try { const v = localStorage.getItem(KEY); if (v === 'soft' || v === 'classic') return v; } catch { /* storage blocked */ }
  return 'classic';
};
export function applySkin(m: SkinMode) {
  document.documentElement.setAttribute('data-skin', m);
  try { localStorage.setItem(KEY, m); } catch { /* storage blocked */ }
}
applySkin(getSkin());
