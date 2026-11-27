import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { archivesApi, showArchive, type ArchiveItem } from '../api';
import { StatusBadge } from './bits';
import './archives.css';
import Toast, { type ToastMsg } from './Toast';

const ver = (a: { v1: number; v2: number; v3: number }) => `${a.v1}.${a.v2}.${a.v3}`;
const stamp = (s?: string) => {
  if (!s) return '-';
  const d = new Date(s); if (isNaN(d.getTime())) return '-';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

type Dlg = { kind: 'history' | 'props'; a: ArchiveItem } | null;

/** Small read-only list dialog used by the History and Property Changes buttons. */
function ListDialog({ docId, lang, dlg, onClose }: { docId: number; lang: string; dlg: NonNullable<Dlg>; onClose: () => void }) {
  const v = { v1: dlg.a.v1, v2: dlg.a.v2, v3: dlg.a.v3 };
  const q = useQuery({
    queryKey: ['arch-dlg', dlg.kind, docId, lang, v.v1, v.v2, v.v3],
    queryFn: () => dlg.kind === 'history' ? archivesApi.history(docId, lang, v) : archivesApi.propertyChanges(docId, lang, v),
  });
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  const items = (q.data?.items ?? []) as Array<{ user?: string; modDate?: string; modDesc?: string; propertyType?: string; oldValue?: string; newValue?: string }>;
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal grp-dlg" style={{ width: 720, maxWidth: '94vw' }} role="dialog" aria-modal="true" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head"><div>
          <h3 style={{ margin: 0 }}>{dlg.kind === 'history' ? 'History' : 'Property Changes'} · version {ver(dlg.a)}</h3>
          <div className="mh" style={{ marginTop: 2 }}>{dlg.kind === 'history' ? 'Modification comments of this version' : 'Name / type / author / process owner / version changes made while this version was current'}</div>
        </div><button className="x" onClick={onClose} aria-label="Close">✕</button></div>
        <div style={{ padding: '4px 20px 12px', maxHeight: '55vh', overflow: 'auto' }}>
          {q.isError && <div className="error" role="alert">{(q.error as Error).message}</div>}
          {q.isLoading && <div className="empty" style={{ height: 70 }}>Loading…</div>}
          {q.data && items.length === 0 && <div className="empty" style={{ height: 80 }}>{dlg.kind === 'history' ? 'No modification comment is stored for this version.' : 'No property change is stored for this version.'}</div>}
          {items.length > 0 && (
            <table className="grid-table">
              <thead><tr><th>Date</th><th>User</th>{dlg.kind === 'props' && <><th>Property</th><th>Old value</th><th>New value</th></>}<th>{dlg.kind === 'props' ? 'Reason' : 'Comment'}</th></tr></thead>
              <tbody>{items.map((m, i) => (
                <tr key={i}><td>{stamp(m.modDate)}</td><td>{m.user ?? '-'}</td>
                  {dlg.kind === 'props' && <><td>{m.propertyType ?? '-'}</td><td>{m.oldValue ?? '-'}</td><td>{m.newValue ?? '-'}</td></>}
                  <td style={{ whiteSpace: 'normal', maxWidth: 'none' }}>{m.modDesc || '-'}</td></tr>))}</tbody>
            </table>
          )}
        </div>
        <div className="modal-foot"><button className="btn-ghost" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

/** Archives tab (manual p. 21): every earlier version of the document, with View (PDF / Original), Show, History and Property Changes. */
export default function ArchivesPane({ docId, lang }: { docId: number; lang: string }) {
  const q = useQuery({ queryKey: ['doc-archives', docId, lang], queryFn: () => archivesApi.list(docId, lang) });
  const [sel, setSel] = useState<string | null>(null);
  const [view, setView] = useState<'pdf' | 'original'>('original');
  const [dlg, setDlg] = useState<Dlg>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<ToastMsg>(null);
  useEffect(() => { setSel(null); }, [docId, lang]);

  if (q.isError) return <div className="error" role="alert">{(q.error as Error).message}</div>;
  if (!q.data) return <div className="empty" style={{ height: 80 }}>Loading…</div>;
  const { canView, items } = q.data;
  const keyOf = (a: ArchiveItem, i: number) => `${ver(a)}#${i}`;
  const cur = items.find((a, i) => keyOf(a, i) === sel) ?? null;

  const show = async (download = false, target: ArchiveItem | null = cur) => {
    if (!target) return;
    setBusy(true); setMsg(null);
    try { await showArchive(docId, lang, target, view, download); }
    catch (e) { setMsg({ ok: false, t: (e as Error).message }); }
    finally { setBusy(false); }
  };
  const why = !canView ? 'You need the Archive right (or Admin rights).' : !cur ? 'Select a version first.' : undefined;

  if (items.length === 0) return <div className="empty" style={{ height: 90 }}>No earlier version is archived yet. A version moves to the archive when a published, released or blocked document is edited or its version is changed.</div>;

  return (
    <div className="arch">
      <div className="arch-grid">
        <table className="grid-table arch-table">
          <thead><tr><th>Version</th><th>Document</th><th>Status</th><th>Date edited</th><th>Reason for edit</th></tr></thead>
          <tbody>{items.map((a, i) => {
            const k = keyOf(a, i);
            return (
              <tr key={k} className={sel === k ? 'arch-sel' : ''} onClick={() => setSel(k)} onDoubleClick={() => { setSel(k); if (canView && a.hasFile && !busy) show(false, a); }}>
                <td><b>{ver(a)}</b></td>
                <td title={a.docName}>{a.docName ?? '-'}</td>
                <td><StatusBadge id={a.status} name={a.statusName} /></td>
                <td>{stamp(a.dateEdited)}</td>
                <td title={a.reason} style={{ whiteSpace: 'normal', maxWidth: 360 }}>{a.reason || '-'}</td>
              </tr>);
          })}</tbody>
        </table>
      </div>
      <aside className="arch-side" aria-label="Archive actions">
        <fieldset className="arch-view">
          <legend>View</legend>
          <label><input type="radio" name={`av-${docId}`} checked={view === 'pdf'} onChange={() => setView('pdf')} /> PDF</label>
          <label><input type="radio" name={`av-${docId}`} checked={view === 'original'} onChange={() => setView('original')} /> Original</label>
        </fieldset>
        <button className="btn-primary" disabled={!canView || !cur || busy || (!!cur && !cur.hasFile)} title={why ?? (cur && !cur.hasFile ? 'The archived file is not on the server.' : 'Open this version')} onClick={() => show()}>{busy ? 'Opening…' : 'Show'}</button>
        <button className="btn-ghost" disabled={!canView || !cur || busy || (!!cur && !cur.hasFile)} title={why ?? 'Save this version to your computer'} onClick={() => show(true)}>⬇ Save</button>
        <button className="btn-ghost" disabled={!canView || !cur} title={why ?? 'Modification comments of this version'} onClick={() => cur && setDlg({ kind: 'history', a: cur })}>History</button>
        <button className="btn-ghost" disabled={!canView || !cur || !cur.propChanges} title={why ?? (cur && !cur.propChanges ? 'No property change for this version' : 'Property changes of this version')} onClick={() => cur && setDlg({ kind: 'props', a: cur })}>Property Changes</button>
        {!canView && <small className="arch-note">Show and History need the Archive right.</small>}
      </aside>
      {dlg && <ListDialog docId={docId} lang={lang} dlg={dlg} onClose={() => setDlg(null)} />}
      <Toast msg={msg} onClose={() => setMsg(null)} />
    </div>
  );
}
