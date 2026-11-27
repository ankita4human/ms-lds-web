import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import Toast, { type ToastMsg } from './Toast';
import { tr } from '../i18n';

const Empty = ({ t }: { t: string }) => <div className="empty" style={{ height: 80 }}>{t}</div>;
const dt = (s?: string) => (s ? new Date(s).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '-');

/** Control tab (manual p. 20): created, released, last edited, last verified, last published, each with date and user. */
export function ControlPane({ docId, lang }: { docId: number; lang: string }) {
  const q = useQuery({ queryKey: ['doc-control', docId, lang], queryFn: () => api.docControl(docId, lang) });
  if (q.isError) return <div className="error" role="alert">{(q.error as Error).message}</div>;
  if (!q.data) return <Empty t="Loading…" />;
  const c = q.data;
  const rows: [string, { on?: string; by: string }][] = [['Created', c.created], ['Released', c.released], [tr('Last edited'), c.edited], [tr('Last verified'), c.verified], [tr('Last published'), c.published]];
  return (
    <table className="grid-table ctl"><thead><tr><th>{tr('Action')}</th><th>{tr('On')}</th><th>{tr('By')}</th></tr></thead>
      <tbody>{rows.map(([l, e]) => <tr key={l}><td><b>{l}</b></td><td>{e.on ? dt(e.on) : '-'}</td><td>{e.by || '-'}</td></tr>)}</tbody></table>
  );
}

/** Catch tab (manual p. 20, 87-89): the catchwords of the document; Add, Activate, Deactivate (several at once with Ctrl / Shift click). */
export function CatchPane({ docId, lang }: { docId: number; lang: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['doc-catch', docId, lang], queryFn: () => api.docCatch(docId, lang) });
  const [sel, setSel] = useState<number[]>([]);
  const [last, setLast] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState<ToastMsg>(null);
  const d = q.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ['doc-catch', docId, lang] });
  async function run(fn: () => Promise<void>) { setBusy(true); setErr(''); try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } }
  if (q.isError) return <div className="error" role="alert">{(q.error as Error).message}</div>;
  if (!d) return <Empty t="Loading…" />;
  if (!d.enabled) return <Empty t="Catchwords are switched off." />;
  if (!d.canManage) return <Empty t="You need the 'Catch Management' right to see the catchwords." />;

  const click = (e: React.MouseEvent, id: number) => {
    if (e.shiftKey && last !== null) {
      const a = d.items.findIndex(x => x.idCatch === last), b = d.items.findIndex(x => x.idCatch === id);
      if (a >= 0 && b >= 0) { const [lo, hi] = a < b ? [a, b] : [b, a]; setSel(d.items.slice(lo, hi + 1).map(x => x.idCatch)); return; }
    }
    if (e.ctrlKey || e.metaKey) setSel(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]); else setSel([id]);
    setLast(id);
  };
  const setState = (active: boolean) => run(async () => { await api.setDocCatchState(docId, lang, sel, active); await refresh(); setMsg({ ok: true, t: active ? tr('Catchword(s) activated.') : tr('Catchword(s) deactivated.') }); });
  const add = () => run(async () => {
    const r = await api.addDocCatch(docId, lang, [text]);
    await refresh(); setAdding(false); setText(''); setMsg({ ok: true, t: r.message });
  });
  return (
    <div className="catch-pane">
      <div className="catch-bar">
        <button className="btn-ghost" onClick={() => { setAdding(true); setErr(''); }} disabled={busy}>{tr('＋ Add')}</button>
        <button className="btn-ghost" onClick={() => setState(true)} disabled={busy || sel.length === 0}>{tr('Activate')}</button>
        <button className="btn-ghost" onClick={() => setState(false)} disabled={busy || sel.length === 0}>{tr('Deactivate')}</button>
        <small className="mh">{tr('Ctrl / Shift + click selects several words.')}{' '}{d.docLevel ? tr('Changes apply to this document.') : tr('Changes apply to the word everywhere.')}</small>
      </div>
      {adding && (
        <div className="catch-add">
          <input autoFocus value={text} maxLength={120} placeholder={tr('New catchword')} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && text.trim()) add(); if (e.key === 'Escape') setAdding(false); }} />
          <button className="btn-primary" onClick={add} disabled={busy || !text.trim()}>{tr('OK')}</button>
          <button className="btn-ghost" onClick={() => setAdding(false)}>{tr('Cancel')}</button>
          <small className="mh">{tr('At least')}{' '}{d.minLen} {tr('characters; separate several words with a comma.')}</small>
        </div>
      )}
      {err && <div className="alert" role="alert">{err}</div>}
      {d.items.length === 0 ? <Empty t="This document has no catchwords." /> : (
        <table className="grid-table catch-tbl"><thead><tr><th>{tr('Catchword')}</th><th>{tr('Status')}</th><th>{tr('Source')}</th></tr></thead>
          <tbody>{d.items.map(i => (
            <tr key={i.idCatch} className={sel.includes(i.idCatch) ? 'sel' : ''} onClick={e => click(e, i.idCatch)}>
              <td>{i.word}</td><td>{i.active ? <span className="catch-on">{tr('● Active')}</span> : <span className="catch-off">{tr('○ Inactive')}</span>}</td><td>{i.manual ? tr('Manual') : tr('Automatic')}</td></tr>))}</tbody></table>
      )}
      <Toast msg={msg} onClose={() => setMsg(null)} />
    </div>
  );
}

/** Linking tab (manual p. 22): outgoing links (documents, external addresses) and incoming links from other documents. */
export function LinkPane({ docId, lang }: { docId: number; lang: string }) {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['doc-links', docId, lang], queryFn: () => api.docLinks(docId, lang) });
  if (q.isError) return <div className="error" role="alert">{(q.error as Error).message}</div>;
  if (!q.data) return <Empty t="Loading…" />;
  const { outgoing, incoming } = q.data;
  const open = (id: number) => nav(`/documents?doc=${id}`);
  return (
    <div className="link-pane">
      <div>
        <b>{tr('Outgoing links')}</b> <small className="mh">({outgoing.length}{tr(') links from this document')}</small>
        {outgoing.length === 0 ? <Empty t="This document has no outgoing links." /> : (
          <table className="grid-table"><thead><tr><th>{tr('Type')}</th><th>{tr('Target')}</th><th>{tr('Link')}</th></tr></thead>
            <tbody>{outgoing.map((o, i) => (
              <tr key={i}>
                <td>{o.kind === 'document' ? tr('📄 Document') : o.kind === 'mail' ? tr('✉ E-mail') : tr('🌐 External')}</td>
                <td>{o.kind === 'document' ? (o.accessible ? <a href={`/documents?doc=${o.targetId}`} onClick={e => { e.preventDefault(); open(o.targetId); }}>#{o.targetId} {o.name}</a> : <span className="mh">#{o.targetId} {tr('(not available)')}</span>) : ''}</td>
                <td style={{ whiteSpace: 'normal', wordBreak: 'break-all' }}>{o.kind === 'external' ? <a href={o.link} target="_blank" rel="noreferrer noopener">{o.link}</a> : o.link}</td>
              </tr>))}</tbody></table>
        )}
      </div>
      <div>
        <b>{tr('Incoming links')}</b> <small className="mh">({incoming.length}{tr(') documents that link to this one')}</small>
        {incoming.length === 0 ? <Empty t="No other document links to this document." /> : (
          <table className="grid-table"><thead><tr><th>{tr('ID')}</th><th>{tr('Document')}</th></tr></thead>
            <tbody>{incoming.map(o => (
              <tr key={o.sourceId}><td>{o.sourceId}</td><td>{o.accessible ? <a href={`/documents?doc=${o.sourceId}`} onClick={e => { e.preventDefault(); open(o.sourceId); }}>{o.name}</a> : <span className="mh">{tr('(not available)')}</span>}</td></tr>))}</tbody></table>
        )}
      </div>
    </div>
  );
}

/** Dependency tab (manual p. 21): the dependencies this document belongs to, with their documents; add to / remove from a dependency. */
export function DependencyPane({ docId, lang }: { docId: number; lang: string }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['doc-deps', docId, lang], queryFn: () => api.docDependencies(docId, lang) });
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<ToastMsg>(null);
  const d = q.data;
  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); await qc.invalidateQueries({ queryKey: ['doc-deps', docId, lang] }); } catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); } };
  if (q.isError) return <div className="error" role="alert">{(q.error as Error).message}</div>;
  if (!d) return <Empty t="Loading…" />;
  return (
    <div className="dist">
      {d.canManage && (
        <div className="dist-add">
          <select value={pick} onChange={e => setPick(e.target.value)} aria-label={tr('Dependency')}>
            <option value="">{tr('Add the document to a dependency…')}</option>
            {d.available.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <button className="btn-ghost" disabled={busy || !pick} onClick={() => run(async () => { await api.addDependencyDocs(Number(pick), [docId]); setPick(''); setMsg({ ok: true, t: tr('The document was added to the dependency.') }); })}>{tr('＋ Add')}</button>
        </div>
      )}
      {d.items.length === 0 && <Empty t="This document is not part of a dependency." />}
      {d.items.map(g => (
        <div key={g.id} className="dist-item">
          <div className="dist-head" style={{ cursor: 'default' }}><span className="dist-ico">🔗</span><b>{g.name}</b><small>{g.documents.length} {tr('document(s)')}</small>
            {d.canManage && <button className="dist-x" title={tr('Remove this document from the dependency')} aria-label={tr('Remove from dependency')} disabled={busy} onClick={() => run(async () => { await api.removeDependencyDoc(g.id, docId); setMsg({ ok: true, t: tr('The document was removed from the dependency.') }); })}>✕</button>}</div>
          <div className="dist-members">{g.documents.map(m => (
            <div key={m.idDoc}>{m.self ? <b>#{m.idDoc} {m.name} {tr('(this document)')}</b> : <a href={`/documents?doc=${m.idDoc}`} onClick={e => { e.preventDefault(); nav(`/documents?doc=${m.idDoc}`); }}>#{m.idDoc} {m.name}</a>}</div>))}</div>
        </div>
      ))}
      <Toast msg={msg} onClose={() => setMsg(null)} />
    </div>
  );
}
