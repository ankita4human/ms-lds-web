import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type DocRow, type VersionResult } from '../api';
import { Spinner } from './Loader';
import VersionPicker, { isHigher, verText, type Ver } from './VersionPicker';
import { tr } from '../i18n';

/** Manual: context menu > Upgrade Revision. Only a higher version can be chosen; not possible for Draft documents. */
export default function ChangeVersionDialog({ doc, lang, onClose, onDone }: {
  doc: DocRow; lang: string; onClose: () => void; onDone: (r: VersionResult) => void;
}) {
  const qc = useQueryClient();
  const current: Ver = { v1: doc.v1 ?? 0, v2: doc.v2 ?? 0, v3: doc.v3 ?? 0 };
  const [ver, setVer] = useState<Ver>({ ...current, v3: current.v3 + 1 });
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const wide = ver.v1 > current.v1 || ver.v2 > current.v2;

  async function submit() {
    if (!isHigher(ver, current)) { setErr(tr('Choose a version higher than {0}.', verText(current))); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.changeVersion(doc.idDoc, { lang, ...ver, comment: comment.trim() || undefined });
      await Promise.all(['docs', 'stats', 'doc-deep'].map(k => qc.invalidateQueries({ queryKey: [k] })));
      onDone(r);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <div className="modal-back" onMouseDown={() => !busy && onClose()}>
      <div className="modal" role="dialog" aria-label={tr('Change version')} onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head"><h3>{tr('Change version')}</h3><button className="x" onClick={onClose} disabled={busy} aria-label={tr('Close')}>✕</button></div>
        <div><b>#{doc.idDoc} {doc.docName}</b><div className="mh">{tr('Current version')}{' '}{verText(current)} · {lang}</div></div>
        <div className="mf">{tr('New version')}<VersionPicker value={ver} onChange={setVer} current={current} />
          <small className="mh">{wide ? tr('A middle or major change also moves the other languages to this version.') : tr('A minor change applies to this language only.')}</small>
        </div>
        <label className="mf">{tr('Comment (optional)')}<input value={comment} maxLength={1000} onChange={e => setComment(e.target.value)} placeholder={tr('Reason for the new version')} />
        </label>
        {err && <div className="alert" role="alert">{err}</div>}
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
          <button className="btn-primary" onClick={submit} disabled={busy || !isHigher(ver, current)}>{busy ? <><Spinner />{tr('Saving')}</> : tr('Change version')}</button>
        </div>
      </div>
    </div>
  );
}
