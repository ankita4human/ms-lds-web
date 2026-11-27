import { useSyncExternalStore } from 'react';
import en, { type Dict } from './en';
import de from './de';
import zh from './zh';
import pl from './pl';
import es from './es';

/** Interface language (texts of the web page, names of statuses and types). It has nothing to do with the document language
 *  (the dropdown next to the theme switch), which decides which language version of the documents and folders is shown. */
export type UiLang = 'DE' | 'EN' | 'ZH' | 'PL' | 'ES';
export const UI_LANGS: { code: UiLang; name: string; flag: string; locale: string }[] = [
  { code: 'DE', name: 'Deutsch', flag: '🇩🇪', locale: 'de-DE' },
  { code: 'EN', name: 'English', flag: '🇬🇧', locale: 'en-GB' },
  { code: 'ZH', name: '中文', flag: '🇨🇳', locale: 'zh-CN' },
  { code: 'PL', name: 'Polski', flag: '🇵🇱', locale: 'pl-PL' },
  { code: 'ES', name: 'Español', flag: '🇪🇸', locale: 'es-ES' },
];
import { TEXTS, MODULE_TEXTS } from './texts';
const DICTS: Record<UiLang, Dict> = { EN: en, DE: de, ZH: zh, PL: pl, ES: es };
const KEY = 'pl_ui_lang';
const valid = (v: string | null | undefined): v is UiLang => !!v && v in DICTS;

function initial(): UiLang {
  try { const s = localStorage.getItem(KEY)?.toUpperCase(); if (valid(s)) return s; } catch { /* storage blocked */ }
  const b = (typeof navigator !== 'undefined' ? navigator.language : 'en').slice(0, 2).toUpperCase();
  return valid(b) ? b : 'EN';
}

let current: UiLang = initial();
const listeners = new Set<() => void>();
if (typeof document !== 'undefined') document.documentElement.lang = current.toLowerCase();

export const getUiLang = (): UiLang => current;
export const uiLocale = () => UI_LANGS.find(l => l.code === current)!.locale;
export function setUiLang(l: UiLang) {
  if (l === current) return;
  current = l;
  try { localStorage.setItem(KEY, l); } catch { /* storage blocked */ }
  document.documentElement.lang = l.toLowerCase();
  listeners.forEach(f => f());
}
/** Called after the language was changed (the app uses it to reload data whose names depend on it). */
export const onUiLangChange = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };

/** Translate a key. Missing keys fall back to English, then to the key itself. {name} placeholders are filled from vars. */
export function t(key: keyof Dict, vars?: Record<string, string | number>): string {
  let s = DICTS[current][key] ?? en[key] ?? key;
  if (vars) for (const k in vars) s = s.split(`{${k}}`).join(String(vars[k]));
  return s;
}

/** Hook: re-renders the component when the interface language changes. */
export function useI18n() {
  const ui = useSyncExternalStore(onUiLangChange, getUiLang);
  return { ui, setUi: setUiLang, t, locale: UI_LANGS.find(l => l.code === ui)!.locale };
}

/** Translate a sentence of the page. The English text itself is the key; {0}, {1} ... are filled from the arguments.
 *  A sentence that is not in the language file is shown in English. */
export function tr(en: string, ...args: unknown[]): string {
  let s = current === 'EN' ? en : (TEXTS[current][en] ?? en);
  if (args.length) s = s.replace(/\{(\d+)\}/g, (m, i) => { const a = args[Number(i)]; return a === undefined || a === null ? '' : String(a); });
  return s;
}

const rev: Partial<Record<UiLang, Map<string, string>>> = {};
/** The English original of a text shown in the current language (the assistant understands English): used for clicked suggestion chips. */
export function untr(s: string): string {
  if (current === 'EN') return s;
  let m = rev[current];
  if (!m) { m = new Map(); for (const [k, v] of Object.entries(TEXTS[current])) if (!m.has(v)) m.set(v, k); rev[current] = m; }
  // chips such as "Open Documents" or "Explain: x" are built from a template: try the whole text first, then give up
  return m.get(s.trim()) ?? s;
}
/** Texts that sit in module-level lists (menus, tiles, option lists) are translated when they reach the page. */
export function startDomTranslate(): void {
  if (typeof document === 'undefined' || (window as unknown as { __domTr?: boolean }).__domTr) return;
  (window as unknown as { __domTr?: boolean }).__domTr = true;
  const mod = new Set(MODULE_TEXTS);
  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  const one = (v: string): string | null => {
    if (current === 'EN') return null;
    const t = v.trim(); if (!t || !mod.has(t)) return null;
    const x = TEXTS[current][t]; if (!x || x === t) return null;
    return v.replace(t, x);
  };
  const node = (n: Node) => {
    if (n.nodeType === 3) { const v = n.nodeValue ?? ''; const x = one(v); if (x !== null) n.nodeValue = x; return; }
    if (n.nodeType !== 1) return;
    const el = n as Element;
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.hasAttribute('data-notr')) return;
    for (const a of ATTRS) { const v = el.getAttribute(a); if (v) { const x = one(v); if (x !== null) el.setAttribute(a, x); } }
    el.childNodes.forEach(node);
  };
  const mo = new MutationObserver(list => {
    for (const m of list) {
      if (m.type === 'characterData') node(m.target);
      else if (m.type === 'attributes') { const el = m.target as Element; const v = el.getAttribute(m.attributeName!); if (v) { const x = one(v); if (x !== null) el.setAttribute(m.attributeName!, x); } }
      else m.addedNodes.forEach(node);
    }
  });
  mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  node(document.body);
  onUiLangChange(() => setTimeout(() => node(document.body), 0));
}
