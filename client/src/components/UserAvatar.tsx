import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import Toast from './Toast';
import { tr } from '../i18n';

/** First letter of the first name + first letter of the last name (one word: its first two letters). */
export function initialsOf(name?: string): string {
  const w = (name ?? '').split(/[\s.,;_@-]+/).filter(Boolean);
  if (w.length === 0) return '';
  if (w.length === 1) return w[0]!.slice(0, 2).toUpperCase();
  return (w[0]![0]! + w[w.length - 1]![0]!).toUpperCase();
}
const gradient = (n: string) => { let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360; return `linear-gradient(135deg, hsl(${h} 70% 52%), hsl(${(h + 40) % 360} 75% 42%))`; };

/** Photo of a user (stored on the server). Without a photo: the initials of the name on a coloured circle (like User management), else a silhouette. */
export default function UserAvatar({ id, className = 'avatar', title, name }: { id?: number; className?: string; title?: string; name?: string }) {
  const q = useQuery({ queryKey: ['photo', id], queryFn: () => api.photo(id!), enabled: !!id, staleTime: 10 * 60_000, retry: false });
  if (q.data) return <img className={className} src={q.data} alt="" title={title ?? name} />;
  const ini = initialsOf(name);
  if (ini) return <span className={`${className} avatar-ini`} style={{ background: gradient(name!) }} role="img" aria-label={name} title={title ?? name}>{ini}</span>;
  return (
    <svg className={`${className} avatar-ph`} viewBox="0 0 64 64" role="img" aria-label={title ?? tr('No photo')} xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="avph-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#cfd8e6" /><stop offset="1" stopColor="#9fb0c8" /></linearGradient></defs>
      <rect width="64" height="64" fill="url(#avph-bg)" />
      <circle cx="32" cy="24" r="11" fill="#6b7c96" opacity=".85" />
      <path d="M8 64c0-13 10-21 24-21s24 8 24 21z" fill="#6b7c96" opacity=".85" />
    </svg>
  );
}

/** Centre-cropped 256x256 JPEG of the chosen picture. */
async function square(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const s = Math.min(bmp.width, bmp.height);
  const c = document.createElement('canvas'); c.width = 256; c.height = 256;
  const g = c.getContext('2d'); if (!g) throw new Error(tr('This browser cannot scale the picture.'));
  g.fillStyle = '#fff'; g.fillRect(0, 0, 256, 256);
  g.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, 256, 256);
  bmp.close();
  return await new Promise<Blob>((ok, no) => c.toBlob(b => (b ? ok(b) : no(new Error(tr('The picture could not be converted.')))), 'image/jpeg', 0.86));
}

/** The user's own avatar with a pencil button: choose a picture (or remove the current one). */
export function AvatarEditor({ id, className = 'avatar', name }: { id?: number; className?: string; name?: string }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const photo = useQuery({ queryKey: ['photo', id], queryFn: () => api.photo(id!), enabled: !!id, staleTime: 10 * 60_000, retry: false });
  const has = !!photo.data;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  async function pick(f?: File) {
    if (!f) return;
    if (!f.type.startsWith('image/')) { setMsg({ ok: false, t: tr('Please choose an image file.') }); return; }
    setBusy(true);
    try { await api.uploadPhoto(await square(f)); await qc.invalidateQueries({ queryKey: ['photo', id] }); setMsg({ ok: true, t: tr('Your photo was changed.') }); }
    catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  }
  async function remove() {
    setBusy(true);
    try { await api.deletePhoto(); await qc.invalidateQueries({ queryKey: ['photo', id] }); setMsg({ ok: true, t: tr('Your photo was removed.') }); }
    catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); }
  }
  return (
    <span className={`av-edit ${busy ? 'busy' : ''}`}>
      <UserAvatar id={id} className={className} name={name} />
      <button type="button" className="av-pen" title={tr('Change my photo')} aria-label={tr('Change my photo')} disabled={busy}
        onClick={e => { e.stopPropagation(); input.current?.click(); }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
      </button>
      {has && <button type="button" className="av-del" title={tr('Remove my photo')} aria-label={tr('Remove my photo')} disabled={busy} onClick={e => { e.stopPropagation(); remove(); }}>×</button>}
      <input ref={input} type="file" accept="image/*" hidden onChange={e => pick(e.target.files?.[0])} />
      <Toast msg={msg} onClose={() => setMsg(null)} />
    </span>
  );
}
