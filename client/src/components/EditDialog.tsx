import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, downloadDocFile, type DocRow, type CheckInResult } from '../api';
import { track } from '../activity';
import { Spinner } from './Loader';
import ConfirmDialog from './ConfirmDialog';
import { ExtBadge } from './bits';
import './editdlg.css';
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
  const [drag, setDrag] = useState(false);
  const ext = doc.extension ? (doc.extension.startsWith('.') ? doc.extension : `.${doc.extension}`) : '';

  useEffect(() => {
    api.lockInfo(doc.idDoc).then(l => setState(!l.locked ? 'free' : l.mine ? 'mine' : 'other'), e => { setErr((e as Error).message); setState('free'); });
  }, [doc.idDoc]);

  async function run(fn: () => Promise<void>) { setBusy(true); setErr(''); try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } }
  const checkOut = () => run(async () => { await api.checkOut(doc.idDoc, lang); setState('mine'); await downloadDocFile(doc.idDoc, lang, `${doc.docName}${doc.extension ? (doc.extension.startsWith('.') ? doc.extension : '.' + doc.extension) : ''}`); track('edit', doc, lang); track('download', doc, lang); });
  const unlock = () => run(async () => { await api.unlock(doc.idDoc); setAskCancel(false); setState('free'); setFile(null); });
  const checkIn = () => run(async () => {
    if (!file) throw new Error('Please choose the edited file.');
    if (!draft && !comment.trim()) throw new Error('Please enter a modification comment.');
    if (versioned && !isHigher(ver, current)) throw new Error(`Choose a version higher than ${verText(current)}.`);
    const f = new FormData();
    f.append('file', file); f.append('lang', lang); f.append('comment', comment.trim());
    if (versioned) { f.append('v1', String(ver.v1)); f.append('v2', String(ver.v2)); f.append('v3', String(ver.v3)); }
    const r = await api.checkIn(doc.idDoc, f);
    track('edit', doc, lang);
    await Promise.all(['docs', 'stats', 'doc-deep'].map(k => qc.invalidateQueries({ queryKey: [k] })));
    onDone(r);
  });

  const step = state === 'mine' ? 2 : 1;
  const kb = file ? Math.max(1, Math.round(file.size / 1024)) : 0;
  const drop = (f?: File | null) => { if (f) setFile(f); };
  return (
    <div className="modal-back" onMouseDown={() => !busy && onClose()}>
      <div className="modal ed-dlg" role="dialog" aria-label="Edit document" onMouseDown={e => e.stopPropagation()}>
        <div className="ed-top">
          <div><h3>Edit document</h3><small>Check out, edit locally, check in</small></div>
          <button className="x" onClick={onClose} disabled={busy} aria-label="Close">✕</button>
        </div>
        <ol className="ed-steps" aria-label="Progress">
          <li className={step > 1 ? 'done' : 'on'}><i>{step > 1 ? '✓' : '1'}</i><span>Check out</span></li>
          <li className="ed-bar" aria-hidden />
          <li className={step === 2 ? 'on' : ''}><i>2</i><span>Check in</span></li>
        </ol>
        <div className="ed-doc">
          <ExtBadge ext={doc.extension} compact />
          <div className="ed-doc-t"><b title={doc.docName}>#{doc.idDoc} {doc.docName}</b>
            <small><span className="ed-pill">v{verText(current)}</span><span className="ed-pill">{lang}</span>{ext && <span className="ed-pill">{ext}</span>}</small></div>
          {state === 'mine' && <span className="ed-lock" title="You have this document checked out">🔒 Checked out by you</span>}
        </div>
        {state === 'loading' && <div className="mh"><Spinner /> Checking the lock…</div>}
        {state === 'other' && <div className="alert" role="alert">This document is checked out by another user.</div>}
        {state === 'free' && (
          <div className="ed-card">
            <div className="ed-card-ico" aria-hidden>⬇️</div>
            <div><b>Step 1 – check out</b>
              <p className="mh">The document is locked for all languages and the file is downloaded so you can edit it.</p></div>
            <button className="ed-go" onClick={checkOut} disabled={busy}>{busy ? <><Spinner />Checking out</> : 'Check out & download'}</button>
          </div>
        )}
        {state === 'mine' && (<>
          <div className="ed-sec">
            <div className="ed-lab">Edited file</div>
            <input ref={input} type="file" hidden accept={ext || undefined} onChange={e => drop(e.target.files?.[0])} />
            <div className={`ed-drop${drag ? ' over' : ''}${file ? ' has' : ''}`} role="button" tabIndex={0}
              onClick={() => input.current?.click()} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click(); } }}
              onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
              onDrop={e => { e.preventDefault(); setDrag(false); drop(e.dataTransfer.files?.[0]); }}>
              {file ? (<>
                <ExtBadge ext={file.name.split('.').pop()} compact />
                <div className="ed-file"><b title={file.name}>{file.name}</b><small>{kb.toLocaleString()} KB · click to choose another</small></div>
                <span className="ed-ok" aria-hidden>✓</span>
              </>) : (<>
                <div className="ed-cloud" aria-hidden>☁️</div>
                <div><b>Drop the edited {ext || 'file'} here</b><small>or click to browse</small></div>
              </>)}
            </div>
          </div>
          <label className="ed-sec" htmlFor="ed-comment">
            <div className="ed-lab">Modification comment{draft ? ' (optional)' : ''}<em>{comment.length} / 900</em></div>
            <textarea id="ed-comment" rows={2} value={comment} maxLength={900} onChange={e => setComment(e.target.value)} placeholder="What was changed?" />
          </label>
          {versioned && (
            <div className="ed-sec">
              <div className="ed-lab">New version<em className="ed-arrow"><span>{verText(current)}</span> → <b>{verText(ver)}</b></em></div>
              <VersionPicker value={ver} onChange={setVer} current={current} />
              <small className="mh">📚 The previous version is kept in the archive. A middle or major change also moves the other languages.</small>
            </div>
          )}
          {!versioned && !draft && <small className="mh">The document goes to status “Edit”.</small>}
        </>)}
        {err && <div className="alert" role="alert">{err}</div>}
        <div className="modal-foot">
          {state === 'mine' && <button className="btn-ghost ed-danger" onClick={() => setAskCancel(true)} disabled={busy}>Cancel check-out</button>}
          <span style={{ flex: 1 }} />
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Close</button>
          {state === 'mine' && <button className="ed-go" onClick={checkIn} disabled={busy || !file}>{busy ? <><Spinner />Checking in</> : '✔ Check in'}</button>}
        </div>
      </div>
      {askCancel && <ConfirmDialog title="Cancel check-out?" confirmLabel="Cancel check-out" busy={busy}
        message="The document is unlocked and your edited file is not uploaded." onConfirm={async () => { await unlock(); setAskCancel(false); }} onCancel={() => setAskCancel(false)} />}
    </div>
  );
}
