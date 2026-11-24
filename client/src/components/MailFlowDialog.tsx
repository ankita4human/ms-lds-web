import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type DocRow, type FlowResult, type MailDraft, type MailPayload, type MailRecip } from '../api';
import { PageLoader, Spinner } from './Loader';
import RichEditor, { blockText, sanitizeHtml } from './RichEditor';
import RecipientInput, { isEmail } from './RecipientInput';

type Stage = 'release' | 'publish';
type Kind = 'release' | 'publish' | 'relpub';
type StageState = { draft: MailDraft; send: boolean; to: MailRecip[]; cc: MailRecip[]; subject: string; html: string; layout: 'modern' | 'classic'; key: number; touched: boolean };

const TITLE: Record<Kind, { title: string; icon: string; button: string }> = {
  release: { title: 'Release document', icon: '🚀', button: 'Release' },
  publish: { title: 'Publish document', icon: '📣', button: 'Publish' },
  relpub: { title: 'Release and publish document', icon: '⚡', button: 'Release & publish' },
};
const STAGE_NAME: Record<Stage, string> = { release: 'Release e-mail', publish: 'Publish e-mail' };

const init = (d: MailDraft, key: number): StageState => ({
  draft: d, send: d.sendDefault, to: d.to, cc: d.cc, subject: d.subject, html: d.html, layout: 'modern', key, touched: false,
});

const hhmm = (iso?: string | null) => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

/**
 * Release / Publish window with the e-mail draft (manual p. 108-109 "Add Email Address", but as a real editor):
 * recipients (To / CC) come from the document's distribution lists and the DB Tool defaults, the text comes from the e-mail template of the
 * document language. The user can change everything, look at a preview, send a test copy to themselves, or send the mail as it is.
 */
export default function MailFlowDialog({ kind, doc, lang, onClose, onDone }: {
  kind: Kind; doc: DocRow; lang: string; onClose: () => void; onDone: (r: FlowResult) => void;
}) {
  const stages: Stage[] = kind === 'relpub' ? ['release', 'publish'] : [kind];
  const opts = useQuery({ queryKey: ['wf-options'], queryFn: api.workflowOptions, enabled: kind !== 'publish' });
  const needPwd = kind !== 'publish' && !!opts.data?.validateOnRelease;
  const [pwd, setPwd] = useState('');
  const [st, setSt] = useState<Partial<Record<Stage, StageState>>>({});
  const [tab, setTab] = useState<Stage>(stages[0]);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [phone, setPhone] = useState(false);
  const [loadErr, setLoadErr] = useState('');
  const [noMail, setNoMail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const [showCc, setShowCc] = useState<Record<Stage, boolean>>({ release: false, publish: false });
  const keyN = useRef(1);
  const pwdRef = useRef<HTMLInputElement>(null);

  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [busy, onClose]);
  useEffect(() => { if (needPwd) pwdRef.current?.focus(); }, [needPwd]);

  // load the draft of every stage
  useEffect(() => {
    let live = true;
    stages.forEach(s => {
      api.mailDraft(doc.idDoc, lang, s)
        .then(d => { if (live) { setSt(p => ({ ...p, [s]: init(d, keyN.current++) })); setShowCc(c => ({ ...c, [s]: d.cc.length > 0 })); } })
        .catch(e => { if (live) setLoadErr((e as Error).message); });
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.idDoc, lang, kind]);

  const cur = st[tab];
  const smtpOk = cur?.draft.smtpOk ?? true;
  const patch = (s: Stage, p: Partial<StageState>) => setSt(o => o[s] ? { ...o, [s]: { ...o[s]!, ...p, touched: true } } : o);

  // header / footer typed in the release mail are used for the publish mail as well (manual p. 109), as long as the publish mail was not edited
  function openTab(s: Stage) {
    setTab(s); setMode('edit'); setErr(''); setInfo('');
    const rel = st.release, pub = st.publish;
    if (s === 'publish' && rel && pub && !pub.touched) {
      const h = blockText(rel.html, 'header'), f = blockText(rel.html, 'footer');
      if (h !== pub.draft.header || f !== pub.draft.footer)
        api.mailDraft(doc.idDoc, lang, 'publish', h, f).then(d => setSt(o => o.publish && !o.publish.touched ? { ...o, publish: { ...init(d, keyN.current++), send: o.publish.send } } : o)).catch(() => { /* keep the draft */ });
    }
  }

  function payload(s: Stage): MailPayload | undefined {
    const x = st[s]; if (!x || noMail) return undefined;
    const html = sanitizeHtml(x.html);
    return { send: x.send && x.draft.smtpOk, to: x.to.map(r => r.email), cc: x.cc.map(r => r.email), subject: x.subject.trim(), html, header: blockText(html, 'header'), footer: blockText(html, 'footer') };
  }

  function check(s: Stage): string {
    const p = payload(s); if (!p || !p.send) return '';
    const all = [...p.to, ...p.cc];
    if (all.length === 0) return `${STAGE_NAME[s]}: add at least one recipient, or switch the e-mail off.`;
    const bad = all.find(e => !isEmail(e)); if (bad) return `${STAGE_NAME[s]}: “${bad}” is not a valid e-mail address.`;
    if (!p.subject) return `${STAGE_NAME[s]}: please enter a subject.`;
    return '';
  }

  async function go() {
    setErr(''); setInfo('');
    for (const s of stages) { const m = check(s); if (m) { setTab(s); setErr(m); return; } }
    setBusy(true);
    try {
      const pw = needPwd ? pwd : undefined;
      const rel = payload('release'), pub = payload('publish');
      onDone(kind === 'release' ? await api.releaseDoc(doc.idDoc, lang, pw, rel)
        : kind === 'publish' ? await api.publishDoc(doc.idDoc, lang, pub)
        : await api.releasePublishDoc(doc.idDoc, lang, pw, rel, pub));
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  async function test() {
    const p = payload(tab); if (!p) return;
    setErr(''); setInfo(''); setTesting(true);
    try { const r = await api.mailTest(doc.idDoc, lang, p); setInfo(`A test copy was sent to ${r.sentTo}.`); }
    catch (e) { setErr((e as Error).message); } finally { setTesting(false); }
  }

  const sending = stages.filter(s => { const p = payload(s); return p?.send; });
  const T = TITLE[kind];
  const label = kind === 'relpub' ? `${T.button}${sending.length ? ` · ${sending.length} e-mail${sending.length > 1 ? 's' : ''}` : ''}`
    : sending.length ? `${T.button} & send e-mail` : `${T.button} without e-mail`;
  const loading = (!noMail && !loadErr && stages.some(s => !st[s])) || (kind !== 'publish' && opts.isLoading);

  const previewDoc = useMemo(() => cur ? `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#eef2f7">${sanitizeHtml(cur.html)}</body></html>` : '', [cur]);

  return (
    <div className="modal-back" style={{ zIndex: 90 }} onMouseDown={() => !busy && onClose()}>
      <div className="modal mf" role="dialog" aria-modal="true" aria-label={T.title} onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="mf-title"><span className="mf-ico" aria-hidden="true">{T.icon}</span>
            <div><h3>{T.title}</h3><div className="mh"><b>{doc.docName}</b> · #{doc.idDoc} · v{doc.v1}.{doc.v2}.{doc.v3} · {lang}</div></div></div>
          <button className="x" onClick={onClose} disabled={busy} aria-label="Close">✕</button>
        </div>

        {needPwd && (
          <label className="wf-pwd" style={{ textAlign: 'left' }}>Confirm with your password
            <input ref={pwdRef} type="password" value={pwd} autoComplete="current-password" onChange={e => setPwd(e.target.value)} onKeyDown={e => e.key === 'Enter' && pwd && !loading && go()} /></label>)}

        {loadErr && !noMail && (
          <div className="mf-warn" role="alert">The e-mail draft could not be prepared: {loadErr}
            <div><button className="btn-ghost" onClick={() => setNoMail(true)}>Continue without e-mail</button></div></div>)}

        {!loadErr && loading && <PageLoader compact label="Preparing the e-mail draft…" />}

        {!noMail && !loadErr && !loading && (
          <>
            {stages.length > 1 && (
              <div className="mf-tabs" role="tablist">
                {stages.map((s, i) => (
                  <button key={s} role="tab" aria-selected={tab === s} className={tab === s ? 'on' : ''} onClick={() => openTab(s)}>
                    <span className="n">{i + 1}</span>{STAGE_NAME[s]}<em className={st[s]?.send && st[s]?.draft.smtpOk ? 'on' : ''}>{st[s]?.send && st[s]?.draft.smtpOk ? 'will be sent' : 'off'}</em></button>))}
              </div>)}

            {cur && (
              <div className="mf-body">
                {!smtpOk && <div className="mf-warn">The mail server is not set up, so e-mails cannot be sent from here. An administrator has to fill Config <code>smtpServer</code>, <code>smtpFrom</code> and <code>pop3login</code> / <code>pop3password</code>.</div>}

                <label className="mf-switch">
                  <input type="checkbox" checked={cur.send && smtpOk} disabled={!smtpOk} onChange={e => patch(tab, { send: e.target.checked })} />
                  <span className="sw" aria-hidden="true" />
                  <span><b>Send e-mail notification</b>
                    <small>{cur.send && smtpOk ? `From ${cur.draft.from}` : kind === 'relpub' ? 'No e-mail for this step.' : 'The step is done without sending an e-mail.'}</small></span>
                </label>

                {cur.send && smtpOk && (
                  <>
                    {tab === 'publish' && cur.draft.quietUntil && (
                      <div className="mf-note">E-mails are paused by a DB Tool setting. This one is sent automatically at {hhmm(cur.draft.quietUntil)}, after publishing.</div>)}
                    {!cur.draft.hasTemplate && <div className="mf-note">No e-mail template was found for this language in table ApplicationEmail - a standard layout is used.</div>}

                    <div className="mf-fields">
                      <RecipientInput label="To" value={cur.to} onChange={v => patch(tab, { to: v })}
                        hint="Distribution lists of the document and the default recipients" />
                      {showCc[tab] || cur.cc.length > 0
                        ? <RecipientInput label="CC" value={cur.cc} onChange={v => patch(tab, { cc: v })} />
                        : <button type="button" className="mf-addcc" onClick={() => setShowCc(c => ({ ...c, [tab]: true }))}>＋ Add CC</button>}
                      <label className="fld"><span>Subject</span>
                        <input value={cur.subject} maxLength={200} onChange={e => patch(tab, { subject: e.target.value })} /></label>
                    </div>

                    <div className="mf-edit-head">
                      <div className="seg" role="tablist" aria-label="View">
                        <button role="tab" aria-selected={mode === 'edit'} className={mode === 'edit' ? 'on' : ''} onClick={() => setMode('edit')}>✏️ Edit</button>
                        <button role="tab" aria-selected={mode === 'preview'} className={mode === 'preview' ? 'on' : ''} onClick={() => setMode('preview')}>👁 Preview</button>
                      </div>
                      {mode === 'preview'
                        ? <div className="seg" aria-label="Device">
                            <button className={!phone ? 'on' : ''} onClick={() => setPhone(false)}>🖥 Desktop</button>
                            <button className={phone ? 'on' : ''} onClick={() => setPhone(true)}>📱 Phone</button></div>
                        : <div className="mf-layout">Layout
                            <div className="seg">
                              <button className={cur.layout === 'modern' ? 'on' : ''} title="Cards, colours and buttons"
                                onClick={() => cur.layout !== 'modern' && patch(tab, { layout: 'modern', html: cur.draft.html, key: keyN.current++ })}>Modern</button>
                              <button className={cur.layout === 'classic' ? 'on' : ''} title="The template as it is stored in the database"
                                onClick={() => cur.layout !== 'classic' && patch(tab, { layout: 'classic', html: cur.draft.classicHtml, key: keyN.current++ })}>Classic</button></div>
                            <button type="button" className="mf-reset" title="Discard all changes of the text"
                              onClick={() => patch(tab, { html: cur.layout === 'modern' ? cur.draft.html : cur.draft.classicHtml, key: keyN.current++ })}>↺ Reset text</button></div>}
                    </div>

                    {mode === 'edit'
                      ? <RichEditor key={`${tab}-${cur.key}`} html={cur.html} onChange={h => setSt(o => o[tab] ? { ...o, [tab]: { ...o[tab]!, html: h, touched: true } } : o)} />
                      : <div className="mf-preview"><iframe title="E-mail preview" sandbox="" srcDoc={previewDoc} style={{ width: phone ? 390 : '100%' }} /></div>}
                    <div className="mh">Type in the text blocks marked “Add a personal message” / “closing text”, or change anything else in the mail. The header and footer you write are remembered for this document.</div>
                  </>)}
              </div>)}
          </>)}

        {err && <div className="alert" role="alert">{err}</div>}
        {info && <div className="mf-ok" role="status">{info}</div>}

        <div className="modal-foot mf-foot">
          {!noMail && cur?.send && smtpOk && !loading
            ? <button className="btn-ghost" onClick={test} disabled={busy || testing} title="Sends this draft to your own address only">{testing ? <><Spinner />Sending test…</> : '✉ Send me a test copy'}</button>
            : <span />}
          <span className="mf-foot-r">
            <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn-primary" style={{ width: 'auto' }} onClick={go} disabled={busy || loading || (needPwd && !pwd)}>
              {busy ? <><Spinner />Please wait</> : (noMail || loadErr) ? T.button : label}</button>
          </span>
        </div>
      </div>
    </div>
  );
}
