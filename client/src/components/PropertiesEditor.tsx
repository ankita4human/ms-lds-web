import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { propsApi } from '../api';
import { Spinner } from './Loader';
import Toast, { type ToastMsg } from './Toast';
import './props.css';
import { tr } from '../i18n';

/** General tab: edit Name, Type, Author and Process owner (manual p. 18-20). A reason is asked for ("Reason for change"); the reason is kept in
 *  Archives > Property Changes and a published document is published again. Only shown with the Admin Document right. */
export default function PropertiesEditor({ docId, lang }: { docId: number; lang: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['doc-props', docId, lang], queryFn: () => propsApi.get(docId, lang) });
  const p = q.data;
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', typeId: 0, authorId: 0, ownerId: 0 });
  const [ask, setAsk] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState<ToastMsg>(null);
  useEffect(() => { setOpen(false); setAsk(false); }, [docId, lang]);
  if (!p?.canEdit) return <Toast msg={msg} onClose={() => setMsg(null)} />;

  const start = () => { setF({ name: p.name ?? '', typeId: p.typeId ?? 0, authorId: p.authorId ?? 0, ownerId: p.ownerId ?? 0 }); setErr(''); setReason(''); setOpen(true); };
  const dirty = f.name.trim() !== (p.name ?? '') || f.typeId !== p.typeId || f.authorId !== p.authorId || f.ownerId !== p.ownerId;
  const labelOf = (list: { id: number; name: string }[] | undefined, id: number) => list?.find(x => x.id === id)?.name ?? '-';
  const diff: { what: string; from: string; to: string }[] = [];
  if (f.name.trim() !== (p.name ?? '')) diff.push({ what: 'Name', from: p.name ?? '-', to: f.name.trim() });
  if (f.typeId !== p.typeId) diff.push({ what: 'Type', from: labelOf(p.types, p.typeId ?? 0), to: labelOf(p.types, f.typeId) });
  if (f.authorId !== p.authorId) diff.push({ what: 'Author', from: labelOf(p.users, p.authorId ?? 0), to: labelOf(p.users, f.authorId) });
  if (f.ownerId !== p.ownerId) diff.push({ what: tr('Process owner'), from: p.ownerId ? labelOf(p.users, p.ownerId) : '-', to: f.ownerId ? labelOf(p.users, f.ownerId) : '-' });

  const save = async () => {
    setBusy(true); setErr('');
    try {
      const r = await propsApi.save(docId, lang, {
        name: f.name.trim() !== (p.name ?? '') ? f.name.trim() : undefined,
        typeId: f.typeId !== p.typeId ? f.typeId : undefined,
        authorId: f.authorId !== p.authorId ? f.authorId : undefined,
        ownerId: f.ownerId !== p.ownerId ? f.ownerId : undefined,
        reason: reason.trim(),
      });
      await Promise.all(['doc', 'docs', 'doc-deep', 'stats', 'doc-props', 'doc-archives'].map(k => qc.invalidateQueries({ queryKey: [k] })));
      setAsk(false); setOpen(false);
      setMsg({ ok: true, t: tr('Saved: {0}.{1}', r.changed.join(', '), r.republished.length ? ' The published document is being published again.' : '') });
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <>
      {!open && <button className="pe-open" onClick={start} title={tr('Change name, type, author or process owner (Admin Document right)')}>{tr('✎ Edit properties')}</button>}
      {open && (
        <section className="pe-card" aria-label={tr('Edit document properties')}>
          <header><b>{tr('Edit properties')}</b><small>{tr('Changes need a reason')}{p.published ? tr(' · the published document will be published again') : ''}</small></header>
          <div className="pe-grid">
            <label>{tr('Name')}<input value={f.name} maxLength={80} onChange={e => setF({ ...f, name: e.target.value })} /></label>
            <label>{tr('Type')}<select value={f.typeId} onChange={e => setF({ ...f, typeId: Number(e.target.value) })}>
              {p.types?.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
            <label>{tr('Author')}<select value={f.authorId} onChange={e => setF({ ...f, authorId: Number(e.target.value) })}>
              {!p.users?.some(u => u.id === f.authorId) && <option value={f.authorId}>-</option>}
              {p.users?.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
            <label>{tr('Process owner')}<select value={f.ownerId} onChange={e => setF({ ...f, ownerId: Number(e.target.value) })}>
              <option value={0}>-</option>{p.users?.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
          </div>
          <footer>
            <button className="btn-ghost" onClick={() => setOpen(false)}>{tr('Cancel')}</button>
            <button className="pe-save" disabled={!dirty || !f.name.trim()} onClick={() => { setErr(''); setAsk(true); }}>{tr('Save changes…')}</button>
          </footer>
        </section>
      )}
      {ask && (
        <div className="modal-back" onMouseDown={() => !busy && setAsk(false)}>
          <div className="modal pe-dlg" role="dialog" aria-label={tr('Reason for change')} onMouseDown={e => e.stopPropagation()}>
            <div className="pe-dlg-head"><span aria-hidden>📝</span><div><h3>{tr('Reason for change')}</h3><small>{tr('Visible later in Archives › Property Changes')}</small></div>
              <button className="x" onClick={() => setAsk(false)} disabled={busy} aria-label={tr('Close')}>✕</button></div>
            <ul className="pe-diff">{diff.map(d => <li key={d.what}><b>{d.what}</b><span className="from">{d.from}</span><i>→</i><span className="to">{d.to}</span></li>)}</ul>
            {p.published && <div className="pe-pub">{tr('🔄 This document is published. After the change it is published again automatically.')}</div>}
            <textarea autoFocus rows={3} maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} placeholder={tr('Why is this changed? (required)')} />
            {err && <div className="alert" role="alert">{err}</div>}
            <div className="pe-dlg-foot"><button className="btn-ghost" onClick={() => setAsk(false)} disabled={busy}>{tr('Cancel')}</button>
              <button className="pe-save" onClick={save} disabled={busy || !reason.trim()}>{busy ? <><Spinner />{tr('Saving')}</> : tr('✔ Save and apply')}</button></div>
          </div>
        </div>
      )}
      <Toast msg={msg} onClose={() => setMsg(null)} />
    </>
  );
}
