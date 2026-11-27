import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type DocRow, type FlowResult } from '../api';
import { Spinner } from './Loader';
import MailFlowDialog from './MailFlowDialog';
import { tr } from '../i18n';

const TEXT: Record<FlowKind, { title: string; icon: string; button: string; text: string }> = {
  verify: { title: 'Verify document', icon: '✅', button: 'Verify', text: 'The document is approved as finished. Only verified documents can be released and then published.' },
  release: { title: 'Release document', icon: '🚀', button: 'Release', text: 'The released version becomes valid. In a minor revision only this language is changed; otherwise all other languages follow the original document and go to Edit status. Only released documents can be published.' },
  publish: { title: 'Publish document', icon: '📣', button: 'Publish', text: 'The document is put in the publishing queue and published in the background: tags are replaced with the document properties and the HTML, PDF and original copies are written to the web folder. The bell at the top tells you when it is done.' },
  relpub: { title: 'Release and publish document', icon: '⚡', button: 'Release & publish', text: 'The document is released and published in one step: all other languages follow as for a normal release, then the document is queued and published in the background.' },
};

/** Verify / Release / Publish / Release+Publish from the document context menu (manual p. 108-109). Release may ask for the password again (config ValidateUserOnRelease). */
export type FlowKind = 'verify' | 'release' | 'publish' | 'relpub';

export default function WorkflowDialog({ kind, doc, lang, onClose, onDone, onRefresh }: {
  kind: FlowKind; doc: DocRow; lang: string; onClose: () => void; onDone: (r: FlowResult) => void; onRefresh?: () => void;
}) {
  const opts = useQuery({ queryKey: ['wf-options'], queryFn: api.workflowOptions, enabled: kind === 'release' || kind === 'relpub' });
  const mailOpt = useQuery({ queryKey: ['mail-options'], queryFn: api.mailOptions, enabled: kind !== 'verify', staleTime: 0, gcTime: 0 });
  const [pwd, setPwd] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const pwdRef = useRef<HTMLInputElement>(null);
  const needPwd = (kind === 'release' || kind === 'relpub') && !!opts.data?.validateOnRelease;
  const verify = kind === 'verify';
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [busy, onClose]);
  useEffect(() => { if (needPwd) pwdRef.current?.focus(); }, [needPwd]);

  async function go() {
    setBusy(true); setErr('');
    try {
      const pw = needPwd ? pwd : undefined;
      onDone(kind === 'verify' ? await api.verifyDoc(doc.idDoc, lang) : kind === 'release' ? await api.releaseDoc(doc.idDoc, lang, pw)
        : kind === 'publish' ? await api.publishDoc(doc.idDoc, lang) : await api.releasePublishDoc(doc.idDoc, lang, pw));
    } catch (e) {
      const m = (e as Error).message; setErr(m); setBusy(false);
      if (kind === 'relpub' && /was released/i.test(m)) onRefresh?.();   // the release part went through: refresh the list behind the dialog
    }
  }
  const loading = (kind === 'release' || kind === 'relpub') && opts.isLoading;
  const T = TEXT[kind];
  // Config SendDefaultMail = 1: release / publish open the e-mail window (manual p. 108-109 "Add Email Address"), otherwise the plain confirmation below
  if (kind !== 'verify' && mailOpt.isLoading) return (
    <div className="modal-back" style={{ zIndex: 90 }}><div className="modal confirm wf" role="status"><div className="confirm-msg"><Spinner /> {tr('Please wait…')}</div></div></div>);
  if (kind !== 'verify' && mailOpt.data?.enabled) return <MailFlowDialog kind={kind} doc={doc} lang={lang} onClose={onClose} onDone={onDone} />;
  return (
    <div className="modal-back" style={{ zIndex: 90 }} onMouseDown={() => !busy && onClose()}>
      <div className="modal confirm wf" role="dialog" aria-modal="true" aria-label={T.title} onMouseDown={e => e.stopPropagation()}>
        <div className={`confirm-ico wf-ico ${verify ? 'v' : 'r'}`} aria-hidden="true">{T.icon}</div>
        <h3>{T.title}?</h3>
        <div className="confirm-msg">
          <b>{doc.docName}</b> <small>#{doc.idDoc} {tr('· version')}{' '}{doc.v1}.{doc.v2}.{doc.v3} · {lang}</small>
          <p>{T.text}</p>
          {needPwd && <label className="wf-pwd">{tr('Confirm with your password')}<input ref={pwdRef} type="password" value={pwd} autoComplete="current-password" onChange={e => setPwd(e.target.value)} onKeyDown={e => e.key === 'Enter' && pwd && go()} /></label>}
          {err && <div className="alert" role="alert">{err}</div>}
        </div>
        <div className="modal-foot" style={{ justifyContent: 'center' }}>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
          <button className="btn-primary" style={{ width: 'auto' }} onClick={go} disabled={busy || loading || (needPwd && !pwd)}>
            {busy ? <><Spinner />{kind === 'verify' || kind === 'release' ? tr('Please wait') : tr('Please wait')}</> : T.button}</button>
        </div>
      </div>
    </div>
  );
}
