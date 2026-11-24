import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, downloadDocFile, type DocRow, type CheckInResult } from '../api';
import { Spinner } from './Loader';
import ConfirmDialog from './ConfirmDialog';
import VersionPicker, { isHigher, verText, type Ver } from './VersionPicker';

const VERSIONED = [3, 6, 8, 9]; // Published, Expired, Released, Blocked: a new file needs a higher version (manual: version window)

/** Edit document = check out (lock + download) -> edit the file locally -> check in (upload, comment, version). */
export default function EditDialog({ doc, lang, onClose, onDone }: {
  doc: DocRow; lang: string; onClose: () => void; onDone: (r: CheckInResult) => void;
}) {
  const qc = useQueryClient();
  const current: Ver = { v1: doc.v1 ?? 0, v2: doc.v2 ?? 0, v3: doc.v3 ?? 0 };
  const versioned = VERSIONED.includes(doc.status);
  const draft = doc.status === 1;
  const [state, setState] = useState<'loading' | 'free' | 'mine' | 'other'>('loading');
  const [askCancel, setAskCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [comment, setComment] = useState('');
  const [ver, setVer] = useState<Ver>({ ...current, v3: current.v3 + 1 });
  const input = useRef<HTMLInputElement>(null);
  const ext = doc.extension ? (doc.extension.startsWith('.') ? doc.extension : `.${doc.extension}`) : '';

  useEffect(() => {
    api.lockInfo(doc.idDoc).then(l => setState(!l.locked ? 'free' : l.mine ? 'mine' : 'other'), e => { setErr((e as Error).message); setState('free'); });
  }, [doc.idDoc]);

  async function run(fn: () => Promise<void>) { setBusy(true); setErr(''); try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } }
  const checkOut = () => run(async () => { await api.checkOut(doc.idDoc, lang); setState('mine'); await downloadDocFile(doc.idDoc, lang, `${doc.docName}${doc.extension ? (doc.extension.startsWith('.') ? doc.extension : '.' + doc.extension) : ''}`); });
  const unlock = () => run(async () => { await api.unlock(doc.idDoc); setAskCancel(false); setState('free'); setFile(null); });
  const checkIn = () => run(async () => {
    if (!file) throw new Error('Please choose the edited file.');
    if (!draft && !comment.trim()) throw new Error('Please enter a modification comment.');
    if (versioned && !isHigher(ver, current)) throw new Error(`Choose a version higher than ${verText(current)}.`);
    const f = new FormData();
    f.append('file', file); f.append('lang', lang); f.append('comment', comment.trim());
    if (versioned) { f.append('v1', String(ver.v1)); f.append('v2', String(ver.v2)); f.append('v3', String(ver.v3)); }
    const r = await api.checkIn(doc.idDoc, f);
    await Promise.all(['docs', 'stats', 'doc-deep'].map(k => qc.invalidateQueries({ queryKey: [k] })));
    onDone(r);
  });

  return (
    <div className="modal-back" onMouseDown={() => !busy && onClose()}>
      <div className="modal" role="dialog" aria-label="Edit document" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head"><h3>Edit document</h3><button className="x" onClick={onClose} disabled={busy} aria-label="Close">✕</button></div>
        <div><b>#{doc.idDoc} {doc.docName}</b><div className="mh">Version {verText(current)} · {lang}{ext && ` · ${ext}`}</div></div>
        {state === 'loading' && <div className="mh"><Spinner /> Checking the lock…</div>}
        {state === 'other' && <div className="alert" role="alert">This document is checked out by another user.</div>}
        {state === 'free' && (
          <div className="mf">Step 1 – check out
            <small className="mh">The document is locked for all languages and the file is downloaded so you can edit it.</small>
            <div><button className="btn-primary" style={{ width: 'auto', padding: '9px 18px' }} onClick={checkOut} disabled={busy}>{busy ? <><Spinner />Checking out</> : 'Check out & download'}</button></div>
          </div>
        )}
        {state === 'mine' && (<>
          <div className="mf">Step 2 – check in the edited file
            <input ref={input} type="file" accept={ext || undefined} onChange={e => setFile(e.target.files?.[0] ?? null)} />
            <small className="mh">{file ? `${file.name} (${Math.max(1, Math.round(file.size / 1024))} KB)` : `Choose the edited ${ext || 'file'}`}</small>
          </div>
          <label className="mf">Modification comment{draft ? ' (optional)' : ''}
            <input value={comment} maxLength={900} onChange={e => setComment(e.target.value)} placeholder="What was changed?" />
          </label>
          {versioned && (
            <div className="mf">New version
              <VersionPicker value={ver} onChange={setVer} current={current} />
              <small className="mh">The previous version is kept in the archive. A middle or major change also moves the other languages.</small>
            </div>
          )}
          {!versioned && !draft && <small className="mh">The document goes to status “Edit”.</small>}
        </>)}
        {err && <div className="alert" role="alert">{err}</div>}
        <div className="modal-foot">
          {state === 'mine' && <button className="btn-ghost" onClick={() => setAskCancel(true)} disabled={busy}>Cancel check-out</button>}
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Close</button>
          {state === 'mine' && <button className="btn-primary" onClick={checkIn} disabled={busy || !file}>{busy ? <><Spinner />Checking in</> : 'Check in'}</button>}
        </div>
      </div>
      {askCancel && <ConfirmDialog title="Cancel check-out?" confirmLabel="Cancel check-out" busy={busy}
        message="The document is unlocked and your edited file is not uploaded." onConfirm={async () => { await unlock(); setAskCancel(false); }} onCancel={() => setAskCancel(false)} />}
    </div>
  );
}
