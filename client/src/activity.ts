import { useSyncExternalStore } from 'react';

/** What the signed-in user did with documents in this login session (view, download, edit, verify ...). Kept in sessionStorage. */
export type DocAction = 'view' | 'download' | 'edit' | 'verify' | 'release' | 'publish';
export type ActEvent = { a: DocAction; at: number };
export type ActEntry = {
  idDoc: number; lang: string; name: string; ext: string; status: number; statusName: string; folder?: string;
  events: ActEvent[]; last: number;
};
export const ACTION_LABEL: Record<DocAction, { past: string; icon: string }> = {
  view: { past: 'Viewed', icon: '👁' }, download: { past: 'Downloaded', icon: '⬇️' }, edit: { past: 'Edited', icon: '✏️' },
  verify: { past: 'Verified', icon: '✅' }, release: { past: 'Released', icon: '🚀' }, publish: { past: 'Published', icon: '📣' },
};

const KEY = 'pl_activity';
const MAX = 50;
let cache: ActEntry[] | null = null;
const subs = new Set<() => void>();

function load(): ActEntry[] {
  if (cache) return cache;
  try { cache = JSON.parse(sessionStorage.getItem(KEY) ?? '[]') as ActEntry[]; } catch { cache = []; }
  return cache;
}
function save(list: ActEntry[]) {
  cache = list;
  try { sessionStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage full or blocked: keep it in memory */ }
  subs.forEach(f => f());
}

type DocLike = { idDoc: number; docName?: string; name?: string; lang?: string; status?: number; statusName?: string; extension?: string | null };

export function track(action: DocAction, d: DocLike, lang: string) {
  const l = d.lang || lang, now = Date.now();
  const list = load().slice();
  const i = list.findIndex(e => e.idDoc === d.idDoc && e.lang === l);
  const old = i >= 0 ? list[i]! : undefined;
  const entry: ActEntry = {
    idDoc: d.idDoc, lang: l, name: d.docName ?? d.name ?? old?.name ?? `Document ${d.idDoc}`,
    ext: (d.extension ?? old?.ext ?? '').replace(/^\./, '').toLowerCase(),
    status: d.status ?? old?.status ?? 0, statusName: d.statusName ?? old?.statusName ?? '', folder: old?.folder,
    events: [...(old?.events ?? []), { a: action, at: now }].slice(-30), last: now,
  };
  if (i >= 0) list.splice(i, 1);
  list.unshift(entry);
  save(list.slice(0, MAX));
}
export function setFolder(idDoc: number, lang: string, folder: string, status?: number, statusName?: string) {
  const list = load().slice(); const i = list.findIndex(e => e.idDoc === idDoc && e.lang === lang);
  if (i < 0) return;
  const e = list[i]!; if (e.folder === folder && (status === undefined || e.status === status)) return;
  list[i] = { ...e, folder, status: status ?? e.status, statusName: statusName ?? e.statusName };
  save(list);
}
export function clearActivity() { save([]); }
export function lastOf(e: ActEntry, a: DocAction): number | undefined { for (let k = e.events.length - 1; k >= 0; k--) if (e.events[k]!.a === a) return e.events[k]!.at; return undefined; }

// A different login must start with an empty list.
window.addEventListener('pl-auth', () => { cache = null; try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } subs.forEach(f => f()); });

export function useActivity(): ActEntry[] {
  return useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f); }; }, load);
}
