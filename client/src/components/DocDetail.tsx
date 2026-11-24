import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DocRow } from '../api';
import ConfirmDialog from './ConfirmDialog';
import Toast, { type ToastMsg } from './Toast';
import { StatusBadge, fmtDate, version } from './bits';
import { ControlPane, CatchPane, LinkPane, DependencyPane } from './DocTabs';

type Tab = 'general' | 'control' | 'catch' | 'history' | 'dep' | 'dist' | 'link' | 'assign';

/** Distribution tab: e-mail distribution lists of the document (legacy addMLtoDoc / removeMLfromDoc / getEmailListByDocs). */
function DistributionPane({ docId, lang }: { docId: number; lang: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['doc-dist', docId, lang], queryFn: () => api.docDistribution(docId, lang) });
  const [open, setOpen] = useState<number[]>([]);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<ToastMsg>(null);
  const [rm, setRm] = useState<{ id: number; name: string } | null>(null);
  const d = q.data;
  const run = async (fn: () => Promise<void>) => { setBusy(true); setMsg(null); try { await fn(); } catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); } };
  const refresh = () => qc.invalidateQueries({ queryKey: ['doc-dist', docId, lang] });
  if (q.isError) return <div className="error" role="alert">{(q.error as Error).message}</div>;
  if (!d) return <div className="empty" style={{ height: 80 }}>Loading…</div>;
  return (
    <div className="dist">
      {d.canManage && (
        <div className="dist-add">
          <select value={pick} onChange={e => setPick(e.target.value)} aria-label="Distribution list">
            <option value="">Add a distribution list…</option>
            {d.available.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <button className="btn-ghost" disabled={busy || !pick} onClick={() => run(async () => { await api.addDocDistribution(docId, lang, Number(pick)); setPick(''); await refresh(); setMsg({ ok: true, t: 'Distribution list added to the document.' }); })}>＋ Add</button>
        </div>
      )}
      {d.lists.length === 0 && <div className="empty" style={{ height: 70 }}>No distribution list is assigned to this document.</div>}
      {d.lists.map(l => (
        <div key={l.id} className="dist-item">
          <div className="dist-head" onClick={() => setOpen(o => o.includes(l.id) ? o.filter(x => x !== l.id) : [...o, l.id])}>
            <span className="caret">{open.includes(l.id) ? '▾' : '▸'}</span><span className="dist-ico">✉</span><b>{l.name}</b><small>{l.members.length} recipient(s)</small>
            {d.canManage && <button className="dist-x" title="Remove from document" aria-label="Remove distribution list" onClick={e => { e.stopPropagation(); setRm({ id: l.id, name: l.name }); }}>✕</button>}
          </div>
          {open.includes(l.id) && <div className="dist-members">{l.members.length ? l.members.map(m => <div key={m.idec}><span>{m.name}</span><small>{m.email}</small></div>) : <small>No recipients.</small>}</div>}
        </div>
      ))}
      <Toast msg={msg} onClose={() => setMsg(null)} />
      {rm && <ConfirmDialog danger title="Remove distribution list?" confirmLabel="Remove" busy={busy}
        message={<>The list <b>{rm.name}</b> will no longer be informed about this document.</>}
        onConfirm={async () => { await run(async () => { await api.removeDocDistribution(docId, lang, rm.id); await refresh(); setMsg({ ok: true, t: 'Distribution list removed from the document.' }); }); setRm(null); }} onCancel={() => setRm(null)} />}
    </div>
  );
}

export default function DocDetail({ doc, lang }: { doc: DocRow; lang: string }) {
  const [tab, setTab] = useState<Tab>('general');
  const q = useQuery({ queryKey: ['doc', doc.idDoc, lang], queryFn: () => api.document(doc.idDoc, lang) });
  const d = q.data?.doc ?? doc;
  const dist = useQuery({ queryKey: ['doc-dist', doc.idDoc, lang], queryFn: () => api.docDistribution(doc.idDoc, lang) });
  return (
    <div className="card detail">
      <div className="tabs">
        <button className={tab === 'general' ? 'on' : ''} onClick={() => setTab('general')}>General</button>
        <button className={tab === 'control' ? 'on' : ''} onClick={() => setTab('control')}>Control</button>
        <button className={tab === 'catch' ? 'on' : ''} onClick={() => setTab('catch')}>Catch</button>
        <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>History ({q.data?.history.length ?? 0})</button>
        <button className={tab === 'dep' ? 'on' : ''} onClick={() => setTab('dep')}>Dependency</button>
        <button className={tab === 'dist' ? 'on' : ''} onClick={() => setTab('dist')}>Distribution ({dist.data?.lists.length ?? 0})</button>
        <button className={tab === 'link' ? 'on' : ''} onClick={() => setTab('link')}>Linking</button>
        <button className={tab === 'assign' ? 'on' : ''} onClick={() => setTab('assign')}>Assignments ({q.data?.paths.length ?? 0})</button>
      </div>
      <div className="detail-body">
        {q.isError && <div className="error" role="alert">Could not load document details.</div>}
        {tab === 'general' && (
          <>
            <h3 style={{ fontSize: 18, marginBottom: 14 }}>{d.docName} <small style={{ color: 'var(--muted)', fontWeight: 400 }}>#{d.idDoc}</small></h3>
            <div className="detail-grid">
              <div className="kv"><small>Type</small>{d.typeName}</div>
              <div className="kv"><small>Status</small><StatusBadge id={d.status} name={d.statusName} /></div>
              <div className="kv"><small>Version</small>{version(d)}</div>
              <div className="kv"><small>Standard language</small>{d.langStandard ?? '-'}</div>
              <div className="kv"><small>Author</small>{d.creator ?? '-'}</div>
              <div className="kv"><small>Process owner</small>{q.data?.processOwner ?? '-'}</div>
              <div className="kv"><small>Created</small>{fmtDate(d.dateCre)}</div>
              <div className="kv"><small>Published</small>{fmtDate(d.datePub)} {d.publisher ? `by ${d.publisher}` : ''}</div>
              <div className="kv"><small>Released</small>{fmtDate(d.dateRel)} {d.releaser ? `by ${d.releaser}` : ''}</div>
              <div className="kv"><small>Modified</small>{fmtDate(d.dateMod)}</div>
              <div className="kv"><small>Expires</small>{fmtDate(d.dateExp)}</div>
            </div>
            {q.data?.notes?.trim() && <div className="notes"><b>Notes</b><br />{q.data.notes}</div>}
          </>
        )}
        {tab === 'history' && (
          q.data?.history.length ? (
            <table className="grid-table"><thead><tr><th>Date</th><th>Version</th><th>User</th><th>Change</th></tr></thead>
              <tbody>{q.data.history.map((h, i) => (
                <tr key={i}><td>{fmtDate(h.modDate)}</td><td>{h.v1}.{h.v2}.{h.v3}</td><td>{h.user ?? '-'}</td>
                  <td style={{ whiteSpace: 'normal' }}>{h.modDesc}</td></tr>))}</tbody></table>
          ) : <div className="empty" style={{ height: 80 }}>No history entries.</div>
        )}
        {tab === 'control' && <ControlPane docId={doc.idDoc} lang={lang} />}
        {tab === 'catch' && <CatchPane docId={doc.idDoc} lang={lang} />}
        {tab === 'dep' && <DependencyPane docId={doc.idDoc} lang={lang} />}
        {tab === 'link' && <LinkPane docId={doc.idDoc} lang={lang} />}
        {tab === 'dist' && <DistributionPane docId={doc.idDoc} lang={lang} />}
        {tab === 'assign' && (
          q.data?.paths.length ? q.data.paths.map((p, i) => <div className="path" key={i}>📁 {p}</div>)
            : <div className="empty" style={{ height: 80 }}>This document is not assigned to a group you can see.</div>
        )}
      </div>
    </div>
  );
}
