import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DocRow, type MailRecip } from '../api';
import { Spinner, PageLoader } from './Loader';
import RecipientInput from './RecipientInput';
import RichEditor, { sanitizeHtml } from './RichEditor';
import { tr } from '../i18n';

const errText = (e: unknown) => (e instanceof Error ? e.message : tr('The action failed.'));
const refresh = (qc: ReturnType<typeof useQueryClient>) => Promise.all(['docs', 'doc', 'doc-deep', 'stats', 'groups'].map(k => qc.invalidateQueries({ queryKey: [k] })));
const dateInput = (d?: string | null) => { if (!d) return ''; const x = new Date(d); return isNaN(+x) || x.getFullYear() <= 1901 ? '' : `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };

function Modal({ title, sub, busy, onClose, children, foot, width = 520 }: { title: string; sub?: string; busy?: boolean; onClose: () => void; children: React.ReactNode; foot: React.ReactNode; width?: number }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [busy, onClose]);
  return (
    <div className="modal-back" style={{ zIndex: 90 }} onMouseDown={() => !busy && onClose()}>
      <div className="modal grp-dlg" style={{ width }} role="dialog" aria-modal="true" aria-label={title} onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head"><div><h3 style={{ margin: 0 }}>{title}</h3>{sub && <div className="mh" style={{ marginTop: 2 }}>{sub}</div>}</div><button className="x" onClick={onClose} disabled={busy} aria-label={tr('Close')}>✕</button></div>
        {children}
        <div className="modal-foot">{foot}</div>
      </div>
    </div>
  );
}

/** Frozen (manual p. 163-165): version 999.999.999, archive history, "do not expire" for good, republished; the e-mail window lets the user mail everybody. */
export function FreezeDialog({ doc, lang, onClose, onDone }: { doc: DocRow; lang: string; onClose: () => void; onDone: (m: string) => void }) {
  const qc = useQueryClient();
  const draft = useQuery({ queryKey: ['frozen-draft', doc.idDoc, lang], queryFn: () => api.mailDraft(doc.idDoc, lang, 'frozen'), staleTime: 0, gcTime: 0 });
  const [send, setSend] = useState(true); const [to, setTo] = useState<MailRecip[]>([]); const [cc, setCc] = useState<MailRecip[]>([]);
  const [subject, setSubject] = useState(''); const [html, setHtml] = useState(''); const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  useEffect(() => {
    const d = draft.data; if (!d || ready) return;
    setTo(d.to); setCc(d.cc); setSubject(d.subject); setHtml(d.html); setSend(d.sendDefault || d.to.length > 0); setReady(true);
  }, [draft.data, ready]);
  const smtpOk = draft.data?.smtpOk ?? false;
  async function go() {
    setBusy(true); setErr('');
    try {
      const mail = send && smtpOk ? { send: true, to: to.map(r => r.email), cc: cc.map(r => r.email), subject, html: sanitizeHtml(html), header: draft.data?.header ?? '', footer: draft.data?.footer ?? '' } : undefined;
      const r = await api.freezeDoc(doc.idDoc, lang, null, mail);
      await refresh(qc); window.dispatchEvent(new Event('pl-publish-queued'));
      onDone(tr('“{0}” is frozen (version 999.999.999) and queued for publishing{1}.', doc.docName, r.mailSent ? '; mail sent' : r.mailError ? `; mail failed: ${r.mailError}` : ''));
    } catch (e) { setErr(errText(e)); setBusy(false); }
  }
  return (
    <Modal title={tr('Freeze document')} sub={`${doc.docName} · #${doc.idDoc} · ${lang}`} busy={busy} onClose={onClose} width={720}
      foot={<><button className="btn-ghost" onClick={onClose} disabled={busy}>{tr('Cancel')}</button><button className="btn-primary" style={{ width: 'auto' }} onClick={go} disabled={busy || draft.isLoading}>{busy ? <Spinner /> : tr('Freeze')}</button></>}>
      <div style={{ display: 'grid', gap: 10 }}>
        <p style={{ margin: 0 }}>{tr('The document stays valid as history but can no longer be changed: status')}{' '}<b>{tr('Frozen')}</b>{tr(', version')}{' '}<b>999.999.999</b>, <b>{tr('do not expire')}</b> {tr('is set for good, the previous version goes to the archive and the document is published again. Only')}{' '}<b>{tr('Defrozen')}</b> {tr('brings it back (to Edit).')}</p>
        {draft.isLoading && <PageLoader compact label={tr('Preparing the e-mail')} />}
        {draft.data && (<>
          <label className="fm-chk"><input type="checkbox" checked={send && smtpOk} disabled={!smtpOk} onChange={e => setSend(e.target.checked)} />{tr('Send an e-mail about the frozen document')}{!smtpOk && tr(' (SMTP is not configured)')}</label>
          {send && smtpOk && (<>
            <RecipientInput label={tr('To')} value={to} onChange={setTo} /><RecipientInput label="CC" value={cc} onChange={setCc} />
            <label className="fm-row" style={{ gridTemplateColumns: '60px 1fr' }}>{tr('Subject')}<input value={subject} onChange={e => setSubject(e.target.value)} style={{ padding: '8px 10px', border: '1px solid #d0d5dd', borderRadius: 10, font: 'inherit' }} /></label>
            <RichEditor html={html} onChange={setHtml} minHeight={180} maxHeight={260} />
          </>)}
        </>)}
        {err && <div className="alert" role="alert">{err}</div>}
      </div>
    </Modal>
  );
}

/** Defrozen (manual p. 166-167): back to Edit, last real version + 1; a new expiry date. */
export function DefreezeDialog({ doc, lang, onClose, onDone }: { doc: DocRow; lang: string; onClose: () => void; onDone: (m: string) => void }) {
  const qc = useQueryClient();
  const [exp, setExp] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  async function go() {
    setBusy(true); setErr('');
    try { const r = await api.defreezeDoc(doc.idDoc, lang, exp || null); await refresh(qc); onDone(tr('“{0}” is defrozen: Edit, version {1}.', doc.docName, r.version)); }
    catch (e) { setErr(errText(e)); setBusy(false); }
  }
  return (
    <Modal title={tr('Defrozen')} sub={`${doc.docName} · #${doc.idDoc} · ${lang}`} busy={busy} onClose={onClose}
      foot={<><button className="btn-ghost" onClick={onClose} disabled={busy}>{tr('Cancel')}</button><button className="btn-primary" style={{ width: 'auto' }} onClick={go} disabled={busy}>{busy ? <Spinner /> : tr('Defrozen')}</button></>}>
      <div style={{ display: 'grid', gap: 10 }}>
        <p style={{ margin: 0 }}>{tr('The document returns to status')}{' '}<b>{tr('Edit')}</b>{tr('. It gets the last version before it was frozen, raised by one (x.y.z+1), and “do not expire” is reset.')}</p>
        <label className="fm-row" style={{ gridTemplateColumns: '150px 1fr' }}>{tr('New expiry date')}<input type="date" value={exp} onChange={e => setExp(e.target.value)} style={{ padding: '8px 10px', border: '1px solid #d0d5dd', borderRadius: 10, font: 'inherit' }} /></label>
        <small className="mh">{tr('Leave empty to use the lifetime of the document type from today.')}</small>
        {err && <div className="alert" role="alert">{err}</div>}
      </div>
    </Modal>
  );
}

/** Change the expiry date / "Do not expire" (manual p. 11, 115, 160). Only for Admin / Admin document users. */
export function ExpiryDialog({ doc, lang, onClose, onDone }: { doc: DocRow; lang: string; onClose: () => void; onDone: (m: string) => void }) {
  const qc = useQueryClient();
  const opt = useQuery({ queryKey: ['frozen-options'], queryFn: api.frozenOptions });
  const [exp, setExp] = useState(dateInput(doc.dateExp));
  const [dne, setDne] = useState(!!doc.doNotExpire);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  async function go() {
    setBusy(true); setErr('');
    try { const r = await api.setExpiry(doc.idDoc, lang, exp || null, opt.data?.doNotExpire ? dne : undefined); await refresh(qc);
      onDone(r.doNotExpire ? tr('The document does not expire.') : tr('Expiry date saved{0}.', r.languages === 'all' ? ' (all languages)' : '')); }
    catch (e) { setErr(errText(e)); setBusy(false); }
  }
  return (
    <Modal title={tr('Expiry')} sub={`${doc.docName} · #${doc.idDoc} · ${lang}`} busy={busy} onClose={onClose}
      foot={<><button className="btn-ghost" onClick={onClose} disabled={busy}>{tr('Cancel')}</button><button className="btn-primary" style={{ width: 'auto' }} onClick={go} disabled={busy}>{busy ? <Spinner /> : tr('Save')}</button></>}>
      <div style={{ display: 'grid', gap: 10 }}>
        <label className="fm-row" style={{ gridTemplateColumns: '150px 1fr' }}>{tr('Expiry date')}<input type="date" value={exp} disabled={dne} onChange={e => setExp(e.target.value)} style={{ padding: '8px 10px', border: '1px solid #d0d5dd', borderRadius: 10, font: 'inherit' }} /></label>
        {opt.data?.doNotExpire && <label className="fm-chk"><input type="checkbox" checked={dne} onChange={e => setDne(e.target.checked)} />{tr('Do not expire')}</label>}
        <small className="mh">{tr('A date in the future brings an expired document back to Published / Released. Changed in the main language, the date is carried to the other languages too.')}</small>
        {err && <div className="alert" role="alert">{err}</div>}
      </div>
    </Modal>
  );
}

/** Link the document to the mandatory standards (manual p. 64-66). Shown from the menu, after creating a document, and when a release is refused. */
export function StandardLinkDialog({ doc, lang, onClose, onDone, intro }: { doc: DocRow | { idDoc: number; docName: string }; lang: string; onClose: () => void; onDone: (m: string) => void; intro?: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['doc-std', doc.idDoc, lang], queryFn: () => api.docStandards(doc.idDoc, lang), staleTime: 0, gcTime: 0 });
  const [ids, setIds] = useState<Set<number> | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  useEffect(() => { if (q.data && !ids) setIds(new Set(q.data.items.filter(i => i.linked).map(i => i.id))); }, [q.data, ids]);
  const toggle = (id: number) => setIds(s => { const n = new Set(s ?? []); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  async function go() {
    setBusy(true); setErr('');
    try { await api.setDocStandards(doc.idDoc, lang, [...(ids ?? [])]); await refresh(qc); await qc.invalidateQueries({ queryKey: ['standards'] }); onDone(tr('Linked to the standards.')); }
    catch (e) { setErr(errText(e)); setBusy(false); }
  }
  const missing = q.data ? q.data.items.filter(i => !(ids ?? new Set()).has(i.id)).length : 0;
  return (
    <Modal title={tr('Link to standard')} sub={`${doc.docName} · #${doc.idDoc}`} busy={busy} onClose={onClose}
      foot={<><button className="btn-ghost" onClick={onClose} disabled={busy}>{tr('Close')}</button><button className="btn-primary" style={{ width: 'auto' }} onClick={go} disabled={busy || !q.data}>{busy ? <Spinner /> : tr('Save')}</button></>}>
      <div style={{ display: 'grid', gap: 8 }}>
        {intro && <div className="alert" role="alert">{intro}</div>}
        <p style={{ margin: 0 }}>{tr('Before a document is released it has to be linked to every')}{' '}<b>{tr('mandatory standard')}</b>.</p>
        {q.isLoading && <PageLoader compact label={tr('Loading standards')} />}
        {q.data && q.data.items.length === 0 && <div className="mh">{tr('There are no mandatory standards (Options → Standard management).')}</div>}
        {q.data?.items.map(i => <label key={i.id} className="fm-chk"><input type="checkbox" checked={ids?.has(i.id) ?? false} onChange={() => toggle(i.id)} />{i.name}</label>)}
        {q.data && q.data.items.length > 0 && missing > 0 && <small className="mh">{missing} {tr('mandatory standard(s) not selected')}{q.data.notifyAdmin ? tr(': the administrator is told when such a document is released.') : '.'}</small>}
        {err && <div className="alert" role="alert">{err}</div>}
      </div>
    </Modal>
  );
}

/** Dependent documents of a document that was changed (manual p. 83-85, 167): choose which ones go to Edit mode. */
export function DependentsDialog({ doc, lang, onClose, onDone }: { doc: { idDoc: number; docName: string }; lang: string; onClose: () => void; onDone: (m: string) => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['dependents', doc.idDoc, lang], queryFn: () => api.dependents(doc.idDoc, lang), staleTime: 0, gcTime: 0 });
  const [ids, setIds] = useState<Set<number> | null>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  useEffect(() => { if (q.data && !ids) setIds(new Set(q.data.items.filter(i => i.movable).map(i => i.idDoc))); }, [q.data, ids]);
  const toggle = (id: number) => setIds(s => { const n = new Set(s ?? []); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  async function go() {
    setBusy(true); setErr('');
    try { const r = await api.editDependents(doc.idDoc, lang, [...(ids ?? [])]); await refresh(qc); onDone(tr('{0} dependent document(s) put in Edit mode.', r.moved)); }
    catch (e) { setErr(errText(e)); setBusy(false); }
  }
  const rows = q.data?.items ?? [];
  return (
    <Modal title={tr('Dependent documents')} sub={`${doc.docName} · #${doc.idDoc}`} busy={busy} onClose={onClose} width={640}
      foot={<><button className="btn-ghost" onClick={onClose} disabled={busy}>{tr('Leave unchanged')}</button><button className="btn-primary" style={{ width: 'auto' }} onClick={go} disabled={busy || !ids || ids.size === 0}>{busy ? <Spinner /> : tr('Put {0} in Edit mode', ids?.size ?? 0)}</button></>}>
      <div style={{ display: 'grid', gap: 8 }}>
        <p style={{ margin: 0 }}>{tr('This document has changed. Choose the dependent documents that have to be checked too; they go to Edit mode and the linked users are informed.')}</p>
        {q.isLoading && <PageLoader compact label={tr('Loading dependent documents')} />}
        <div style={{ maxHeight: 300, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 10 }}>
          <table className="tbl" style={{ width: '100%', fontSize: 13 }}><thead><tr><th /><th>{tr('ID')}</th><th>{tr('Document')}</th><th>{tr('Version')}</th><th>{tr('Status')}</th><th>{tr('Dependency')}</th></tr></thead>
            <tbody>{rows.map(r => (
              <tr key={r.idDoc} style={r.movable ? undefined : { opacity: .5 }}>
                <td><input type="checkbox" disabled={!r.movable} checked={r.movable && (ids?.has(r.idDoc) ?? false)} onChange={() => toggle(r.idDoc)} aria-label={tr('Select {0}', r.name)} /></td>
                <td>{r.idDoc}</td><td><b>{r.name}</b></td><td>{r.version}</td><td>{r.statusName}</td><td>{r.dependency}</td></tr>))}</tbody></table>
        </div>
        {err && <div className="alert" role="alert">{err}</div>}
      </div>
    </Modal>
  );
}

/** Several documents at once (legacy changeDocumentExpDateAndStatusForAll): Frozen or Defrozen one after the other; per document the default e-mail is sent when SMTP and recipients exist. */
export function BulkFrozenDialog({ kind, docs, lang, onClose, onFinished }: { kind: 'freeze' | 'defreeze'; docs: DocRow[]; lang: string; onClose: () => void; onFinished: (queued: boolean) => void }) {
  const qc = useQueryClient();
  const ok = docs.filter(d => kind === 'freeze' ? d.status === 3 || d.status === 6 || d.status === 8 : d.status === 11);
  const [exp, setExp] = useState(''); const [mail, setMail] = useState(true);
  const [busy, setBusy] = useState(false); const [done, setDone] = useState<{ id: number; name: string; ok: boolean; t: string }[] | null>(null);
  const [at, setAt] = useState(0);
  async function go() {
    setBusy(true); const out: { id: number; name: string; ok: boolean; t: string }[] = []; let queued = false;
    for (let i = 0; i < ok.length; i++) {
      const d = ok[i]!; setAt(i + 1);
      try {
        if (kind === 'freeze') {
          let payload;
          if (mail) { try { const m = await api.mailDraft(d.idDoc, lang, 'frozen'); if (m.smtpOk && m.to.length) payload = { send: true, to: m.to.map(r => r.email), cc: m.cc.map(r => r.email), subject: m.subject, html: sanitizeHtml(m.html), header: m.header, footer: m.footer }; } catch { /* no mail */ } }
          const r = await api.freezeDoc(d.idDoc, lang, null, payload); queued = true;
          out.push({ id: d.idDoc, name: d.docName, ok: true, t: tr('Frozen{0}', r.mailSent ? ', mail sent' : r.mailError ? `, mail failed: ${r.mailError}` : '') });
        } else {
          const r = await api.defreezeDoc(d.idDoc, lang, exp || null); out.push({ id: d.idDoc, name: d.docName, ok: true, t: tr('Edit, version {0}', r.version) });
        }
      } catch (e) { out.push({ id: d.idDoc, name: d.docName, ok: false, t: errText(e) }); }
    }
    setDone(out); setBusy(false); await refresh(qc); onFinished(queued);
  }
  const title = kind === 'freeze' ? tr('❄️ Frozen') : tr('🔥 Defrozen');
  return (
    <Modal title={tr('{0}: {1} documents', title, docs.length)} sub={tr('{0} can be {1} · {2}', ok.length, kind === 'freeze' ? 'frozen' : 'defrozen', lang)} busy={busy} onClose={onClose} width={640}
      foot={done ? <button className="btn-primary" style={{ width: 'auto' }} onClick={onClose}>{tr('Close')}</button>
        : <><button className="btn-ghost" onClick={onClose} disabled={busy}>{tr('Cancel')}</button><button className="btn-primary" style={{ width: 'auto' }} onClick={go} disabled={busy || ok.length === 0}>{busy ? <><Spinner /> {at}/{ok.length}</> : kind === 'freeze' ? tr('Freeze all') : tr('Defrost all')}</button></>}>
      <div style={{ display: 'grid', gap: 10 }}>
        {!done && (kind === 'freeze'
          ? <><p style={{ margin: 0 }}>{tr('Each document gets status')}{' '}<b>{tr('Frozen')}</b>{tr(', version')}{' '}<b>999.999.999</b>{tr(', “do not expire” for good, an archive copy, and is published again.')}</p>
            <label className="fm-chk"><input type="checkbox" checked={mail} onChange={e => setMail(e.target.checked)} />{tr('Send the default e-mail for every document (when SMTP and recipients are set up)')}</label></>
          : <><p style={{ margin: 0 }}>{tr('Each document returns to')}{' '}<b>{tr('Edit')}</b> {tr('with its last real version + 1.')}</p>
            <label className="fm-row" style={{ gridTemplateColumns: '150px 1fr' }}>{tr('New expiry date')}<input type="date" value={exp} onChange={e => setExp(e.target.value)} style={{ padding: '8px 10px', border: '1px solid #d0d5dd', borderRadius: 10, font: 'inherit' }} /></label>
            <small className="mh">{tr('Leave empty to use the lifetime of each document type.')}</small></>)}
        <div className="um-list" style={{ maxHeight: 260, overflow: 'auto' }}>
          {(done ?? docs.map(d => ({ id: d.idDoc, name: d.docName, ok: ok.includes(d), t: ok.includes(d) ? tr('Ready') : kind === 'freeze' ? tr('Only released, published or expired documents') : tr('Not frozen') }))).map(x =>
            <div key={x.id} className="um-item" style={{ display: 'flex', gap: 8, opacity: x.ok ? 1 : .55 }}><span>{x.ok ? '✅' : '⚠️'}</span><span style={{ flex: 1 }}>#{x.id} {x.name}</span><small className="mh">{x.t}</small></div>)}
        </div>
      </div>
    </Modal>
  );
}
