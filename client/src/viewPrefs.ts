import { useSyncExternalStore } from 'react';

/** Program options > View tab (manual p. 33): font of the tree and grid, "Show date only" and which grid columns are visible.
 *  Kept per browser (localStorage) and applied at once everywhere. */
export type ViewPrefs = { font: string; size: number; dateOnly: boolean; hidden: string[] };
export const DEFAULT_PREFS: ViewPrefs = { font: '', size: 0, dateOnly: true, hidden: [] };
const KEY = 'pl_view_prefs';
const EVT = 'pl-view-prefs';

/** Grid columns in the order of the document grid; `pos` is the position of the column in the table (1 = selection box). */
export const GRID_COLUMNS: { k: string; label: string; pos: number; locked?: boolean }[] = [
  { k: 'id', label: 'ID', pos: 2 }, { k: 'name', label: 'Document', pos: 3, locked: true }, { k: 'status', label: 'Status', pos: 4 },
  { k: 'type', label: 'Type', pos: 5 }, { k: 'ver', label: 'Version', pos: 6 }, { k: 'app', label: 'Application', pos: 7 },
  { k: 'lang', label: 'Standard language', pos: 8 }, { k: 'created', label: 'Created', pos: 9 }, { k: 'creator', label: 'Creator', pos: 10 },
  { k: 'pub', label: 'Published', pos: 11 }, { k: 'publisher', label: 'Publisher', pos: 12 }, { k: 'rel', label: 'Released', pos: 13 }, { k: 'exp', label: 'Expires', pos: 14 },
];
export const FONTS = ['Verdana', 'Segoe UI', 'Arial', 'Tahoma', 'Calibri', 'Trebuchet MS', 'Georgia', 'Times New Roman', 'Courier New', 'Consolas'];

let cache: ViewPrefs | null = null;
function read(): ViewPrefs {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<ViewPrefs> | null;
    if (j && typeof j === 'object') return { font: typeof j.font === 'string' ? j.font : '', size: Number(j.size) || 0, dateOnly: j.dateOnly !== false, hidden: Array.isArray(j.hidden) ? j.hidden.filter(x => x !== 'name') : [] };
  } catch { /* storage blocked or damaged */ }
  return DEFAULT_PREFS;
}
export const getPrefs = (): ViewPrefs => (cache ??= read());
export function setPrefs(p: ViewPrefs) {
  cache = { ...p, hidden: p.hidden.filter(x => x !== 'name') };
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* storage blocked */ }
  window.dispatchEvent(new Event(EVT));
}
const subscribe = (cb: () => void) => {
  const on = () => { cache = null; cb(); };
  window.addEventListener(EVT, cb); window.addEventListener('storage', on);
  return () => { window.removeEventListener(EVT, cb); window.removeEventListener('storage', on); };
};
export const useViewPrefs = (): ViewPrefs => useSyncExternalStore(subscribe, getPrefs, () => DEFAULT_PREFS);

/** dd/mm/yyyy, plus hh:mm when "Show date only" is off. */
export function fmtStamp(s: string | undefined | null, dateOnly: boolean): string {
  if (!s) return '-';
  const d = new Date(s); if (isNaN(d.getTime())) return '-';
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
  return dateOnly ? day : `${day} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** CSS that applies the preferences to the folder tree and the document grid. */
export function viewCss(p: ViewPrefs): string {
  const css: string[] = [];
  const fam = p.font ? `font-family: "${p.font.replace(/"/g, '')}", system-ui, sans-serif !important;` : '';
  const siz = p.size > 0 ? `font-size: ${p.size}pt !important;` : '';
  if (fam || siz) css.push(`.docs-table th, .docs-table td, .docs-table td b, .tree-card .tree-row, .tree-card .tt-l, .tree-card .nm { ${fam} ${siz} }`);
  for (const c of GRID_COLUMNS) if (p.hidden.includes(c.k) && !c.locked) css.push(`.docs-table th:nth-child(${c.pos}), .docs-table td:nth-child(${c.pos}) { display: none !important; }`);
  return css.join('\n');
}
