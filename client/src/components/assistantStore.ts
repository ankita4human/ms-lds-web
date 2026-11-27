import type { Ctx, Msg } from './assistantEngine';
import { tr } from '../i18n';

export type Conv = { id: string; title: string; updated: number; msgs: Msg[]; ctx: Ctx };
const KEY = 'pl_ai_chats_v1', ACTIVE = 'pl_ai_active_v1';

export function loadConvs(): Conv[] { try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as Conv[]; } catch { return []; } }
export function saveConvs(c: Conv[]) {
  const slim = c.slice(0, 40).map(x => ({ ...x, msgs: x.msgs.slice(-60) }));
  try { localStorage.setItem(KEY, JSON.stringify(slim)); } catch { /* storage full or blocked */ }
}
export const getActive = (): string | null => { try { return localStorage.getItem(ACTIVE); } catch { return null; } };
export const setActive = (id: string) => { try { localStorage.setItem(ACTIVE, id); } catch { /* ignore */ } };
export const newConv = (): Conv => ({ id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), title: tr('New chat'), updated: Date.now(), msgs: [], ctx: {} });
export const titleOf = (text: string) => { const t = text.replace(/\s+/g, ' ').trim(); return t.length > 38 ? t.slice(0, 36) + '…' : t || tr('New chat'); };
