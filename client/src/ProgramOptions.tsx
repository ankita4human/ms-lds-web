import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, type AppTag } from './api';
import { useLang } from './LangContext';
import { Spinner, PageLoader } from './components/Loader';
import ConfirmDialog from './components/ConfirmDialog';
import { IconSliders } from './components/Icons';
import PageHero from './components/PageHero';
import Toast from './components/Toast';
import { Switch } from './components/FormBits';

type Panel = null | 'deleted' | 'links' | 'tags' | 'catch' | 'web' | 'frozen';
type Msg = { ok: boolean; t: string } | null;
const CARDS: { id: Exclude<Panel, null>; icon: string; title: string; text: string }[] = [
  { id: 'deleted', icon: '🗑️', title: 'View deleted documents', text: 'Shows you all deleted documents of the system.' },
  { id: 'links', icon: '🔗', title: 'View captured links', text: 'Show you all documents with captured links.' },
  { id: 'tags', icon: '🏷️', title: 'Application Level Tags', text: 'Create application level tags' },
  { id: 'catch', icon: '🔑', title: 'Application level catchWords', text: 'Create application level catchWords' },
  { id: 'web', icon: '🌐', title: 'Web History', text: 'View access history of documents on web' },
  { id: 'frozen', icon: '❄️', title: 'Frozen / Defrozen', text: 'Switch the Frozen and Defrozen document feature on or off' },
];
const fmt = (s?: string | null) => s ? new Date(s).toLocaleString() : '';
const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Options > Program options > Admin tab (manual p. 91-92; legacy "MS LDS-Program-options" window). One card per admin function;
 *  a card opens its panel on this page. Needs the Administrator right (the legacy server checks rightAdmin). */
export default function ProgramOptions() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const nav = useNavigate();
  const [panel, setPanel] = useState<Panel>(null);
  const [msg, setMsg] = useState<Msg>(null);
  if (me.isLoading) return <PageLoader label="Loading" />;
  if (!me.data?.isAdmin) return <div className="um"><div className="card" style={{ padding: 20 }}>Program options are only available to administrators.</div></div>;
  const card = CARDS.find(c => c.id === panel);
  return (
    <div className="um">
      <PageHero icon={<IconSliders />} title="Program options" sub={card ? card.title : 'Administration of the application'} chips={[{ n: 'Admin', label: 'tab' }]} />
      <div className="card" style={{ padding: 16 }}>
        <div className="po-tabs po-noprint"><span>View</span><span>Server</span><span className="on">Admin</span></div>
        {!panel && (<>
          <div className="po-grid">
            {CARDS.map(c => (
              <button key={c.id} className="po-card" onClick={() => setPanel(c.id)}>
                <span className="po-ico" aria-hidden="true">{c.icon}</span><h3>{c.title}</h3><p>{c.text}</p></button>))}
          </div>
          <div className="modal-foot" style={{ marginTop: 14 }}><button className="btn-ghost" onClick={() => nav('/documents')}>Close</button></div>
        </>)}
        {panel && (<>
          <div className="po-bar po-noprint"><button className="btn-ghost" onClick={() => setPanel(null)}>‹ Back to the cards</button><b>{card?.title}</b></div>
          {panel === 'deleted' && <DeletedPanel />}
          {panel === 'links' && <LinksPanel />}
          {panel === 'tags' && <TagsPanel setMsg={setMsg} />}
          {panel === 'catch' && <CatchPanel setMsg={setMsg} />}
          {panel === 'web' && <WebPanel setMsg={setMsg} />}
          {panel === 'frozen' && <FrozenPanel setMsg={setMsg} />}
        </>)}
      </div>
      <Toast msg={msg} onClose={() => setMsg(null)} />
    </div>
  );
}

function DeletedPanel() {
  const { lang } = useLang();
  const [text, setText] = useState(''); const [q, setQ] = useState(''); const [page, setPage] = useState(1);
  useEffect(() => { const t = setTimeout(() => { setQ(text.trim()); setPage(1); }, 350); return () => clearTimeout(t); }, [text]);
  const r = useQuery({ queryKey: ['po-deleted', lang, q, page], queryFn: () => api.deletedDocs(lang, q, page), placeholderData: p => p });
  const pages = Math.max(1, Math.ceil((r.data?.total ?? 0) / (r.data?.pageSize ?? 100)));
  return (<>
    <div className="po-bar"><input value={text} onChange={e => setText(e.target.value)} placeholder="Search by name or ID…" aria-label="Search deleted documents" />
      <span className="mh">{r.data ? `${r.data.total} deleted document(s) in ${lang}` : ''}</span></div>
    {r.isLoading && <PageLoader compact label="Loading" />}
    {r.error && <div className="alert">{(r.error as Error).message}</div>}
    {r.data && r.data.items.length === 0 && <div className="mh" style={{ padding: 12 }}>No deleted documents.</div>}
    {r.data && r.data.items.length > 0 && (
      <div className="um-scroll"><table className="grid-table"><thead><tr><th>ID</th><th>Document</th><th>Version</th><th>Type</th><th>Deleted on</th><th>Deleted by</th></tr></thead>
        <tbody>{r.data.items.map(d => <tr key={d.id}><td>{d.id}</td><td>{d.name}</td><td>{d.version}</td><td>{d.type}</td><td>{fmt(d.deleted)}</td><td>{d.deletedBy}</td></tr>)}</tbody></table></div>)}
    {pages > 1 && (<div className="catch-pager"><button className="btn-ghost" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>‹ Previous</button><span>Page {page} of {pages}</span>
      <button className="btn-ghost" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next ›</button></div>)}
  </>);
}

function LinksPanel() {
  const { lang } = useLang();
  const [type, setType] = useState('all');
  const r = useQuery({ queryKey: ['po-links', lang, type], queryFn: () => api.brokenLinks(lang, type), gcTime: 0 });
  return (<>
    <div className="po-bar">
      <label>Link type&nbsp;<select value={type} onChange={e => setType(e.target.value)}><option value="all">All</option><option value="int">Internal</option><option value="net">Network</option></select></label>
      <span className="sp" /><button className="btn-ghost po-noprint" onClick={() => window.print()} disabled={!r.data?.items.length}>Print</button></div>
    {r.isFetching && <PageLoader compact label="Checking the links" />}
    {r.error && <div className="alert">{(r.error as Error).message}</div>}
    {r.data && !r.isFetching && r.data.items.length === 0 && <div className="mh" style={{ padding: 12 }}>No broken links found.</div>}
    {r.data && !r.isFetching && r.data.items.length > 0 && (
      <div className="um-scroll"><table className="grid-table"><thead><tr><th>Document</th><th>Links to</th><th>Problem</th></tr></thead>
        <tbody>{r.data.items.map((l, i) => <tr key={i}><td>#{l.id} {l.name}</td><td>{l.targetId > 0 ? `#${l.targetId} ` : ''}{l.target}</td><td>{l.error}</td></tr>)}</tbody></table></div>)}
    <small className="mh">Internal: links to documents that are missing, not shown on the web, expired or never released. Network: UNC paths the server cannot reach.</small>
  </>);
}

function TagsPanel({ setMsg }: { setMsg: (m: Msg) => void }) {
  const { lang } = useLang();
  const qc = useQueryClient();
  const r = useQuery({ queryKey: ['po-tags', lang], queryFn: () => api.appTags(lang) });
  const [hist, setHist] = useState(false);
  const h = useQuery({ queryKey: ['po-tag-hist', lang], queryFn: () => api.appTagHistory(lang), enabled: hist, gcTime: 0 });
  const [form, setForm] = useState<{ id: number | null; desc: string; repl: string } | null>(null);
  const [del, setDel] = useState<AppTag | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['po-tags'] }), qc.invalidateQueries({ queryKey: ['tags'] }), qc.invalidateQueries({ queryKey: ['po-tag-hist'] })]);
  async function run(fn: () => Promise<string>) { setBusy(true); try { const m = await fn(); await refresh(); setMsg({ ok: true, t: m }); } catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); } }
  const save = () => run(async () => {
    const f = form!;
    if (f.id === null) await api.addAppTag(lang, f.desc.trim(), f.repl.trim()); else await api.editAppTag(f.id, lang, f.desc.trim(), f.repl.trim());
    setForm(null); return f.id === null ? 'Application level tag created.' : 'Application level tag saved.';
  });
  const remove = () => run(async () => { await api.deleteAppTag(del!.id, lang); setDel(null); return 'Application level tag deleted.'; });
  const max = r.data?.maxDescription ?? 21, maxR = r.data?.maxReplacement ?? 50;
  return (<>
    <div className="po-bar"><button className="btn-primary" onClick={() => setForm({ id: null, desc: '', repl: '' })}>+ New application level tag</button>
      <button className="btn-ghost" onClick={() => setHist(v => !v)}>{hist ? 'Hide history' : 'History'}</button>
      <span className="mh">Tags are written as $$description$$ and are replaced by the replacement text.</span></div>
    {r.isLoading && <PageLoader compact label="Loading" />}
    {r.error && <div className="alert">{(r.error as Error).message}</div>}
    {r.data && r.data.items.length === 0 && <div className="mh" style={{ padding: 12 }}>No application level tags for {lang} yet.</div>}
    {r.data && r.data.items.length > 0 && (
      <table className="grid-table"><thead><tr><th>Tag</th><th>Replacement</th><th style={{ width: 150 }} /></tr></thead>
        <tbody>{r.data.items.map(t => (<tr key={t.id}><td><code>{t.tag}</code></td><td>{t.replacement}</td>
          <td><button className="btn-ghost" onClick={() => setForm({ id: t.id, desc: t.description, repl: t.replacement })}>Edit</button> <button className="btn-ghost" onClick={() => setDel(t)}>Delete</button></td></tr>))}</tbody></table>)}
    {hist && (<div style={{ marginTop: 14 }}>
      <b>History</b>{h.isLoading && <Spinner />}
      {h.data && h.data.length === 0 && <div className="mh">No history.</div>}
      {h.data && h.data.length > 0 && (<div className="um-scroll"><table className="grid-table"><thead><tr><th>Tag</th><th>Replacement</th><th>Created</th><th>By</th><th>Changed / removed</th><th>State</th></tr></thead>
        <tbody>{h.data.map(x => <tr key={x.sNo}><td><code>{x.name}</code></td><td>{x.replacement}</td><td>{fmt(x.created)}</td><td>{x.createdBy}</td><td>{fmt(x.modified)}</td><td>{x.current ? 'Current' : 'Old'}</td></tr>)}</tbody></table></div>)}</div>)}
    {form && (
      <div className="modal-back" onMouseDown={() => !busy && setForm(null)}>
        <div className="modal" role="dialog" aria-label="Application level tag" onMouseDown={e => e.stopPropagation()}>
          <div className="modal-head"><h3>{form.id === null ? 'New application level tag' : 'Edit application level tag'}</h3><button className="x" onClick={() => setForm(null)} aria-label="Close">✕</button></div>
          <div className="po-form">
            <label className="mf">Tag Description<input autoFocus value={form.desc} maxLength={max} onChange={e => setForm({ ...form, desc: e.target.value })} /></label>
            <label className="mf">Replacement<input value={form.repl} maxLength={maxR} onChange={e => setForm({ ...form, repl: e.target.value })} /></label>
            <small className="mh">Tag: <code>{`$$${form.desc.trim() || '…'}$$`}</code></small>
          </div>
          <div className="modal-foot"><button className="btn-ghost" onClick={() => setForm(null)} disabled={busy}>Cancel</button>
            <button className="btn-primary" onClick={save} disabled={busy || !form.desc.trim() || !form.repl.trim()}>{busy ? <Spinner /> : 'Save'}</button></div>
        </div></div>)}
    {del && <ConfirmDialog danger title="Delete the tag?" confirmLabel="Delete" busy={busy} message={<>The tag <b>{del.tag}</b> will be removed. Documents that still contain it keep the text unreplaced.</>} onConfirm={remove} onCancel={() => setDel(null)} />}
  </>);
}

function CatchPanel({ setMsg }: { setMsg: (m: Msg) => void }) {
  const { lang } = useLang();
  const qc = useQueryClient();
  const r = useQuery({ queryKey: ['po-catch', lang], queryFn: () => api.appCatch(lang) });
  const [text, setText] = useState('');
  const [sel, setSel] = useState<number[]>([]);
  const [askDel, setAskDel] = useState(false);
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<string>) { setBusy(true); try { const m = await fn(); await qc.invalidateQueries({ queryKey: ['po-catch'] }); setMsg({ ok: true, t: m }); } catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); } }
  const add = () => run(async () => { const x = await api.addAppCatch(lang, [text]); setText(''); return `${x.added} catchword(s) created${x.existing ? `, ${x.existing} already existed` : ''}.`; });
  const setState = (a: boolean) => run(async () => { const x = await api.setAppCatchState(lang, sel, a); return `${x.changed} catchword(s) ${a ? 'activated' : 'deactivated'}.`; });
  const remove = () => run(async () => { const x = await api.deleteAppCatch(sel); setSel([]); setAskDel(false); return `${x.removed} catchword(s) deleted.`; });
  const items = r.data?.items ?? [];
  return (<>
    <div className="po-bar"><input value={text} onChange={e => setText(e.target.value)} maxLength={120} placeholder="New catchwords (separate with space, comma or ;)" aria-label="New catchwords" style={{ minWidth: 280 }}
      onKeyDown={e => { if (e.key === 'Enter' && text.trim() && !busy) add(); }} />
      <button className="btn-primary" onClick={add} disabled={busy || !text.trim()}>Create</button><span className="sp" />
      <button className="btn-ghost" onClick={() => setState(true)} disabled={busy || !sel.length}>Activate</button>
      <button className="btn-ghost" onClick={() => setState(false)} disabled={busy || !sel.length}>Deactivate</button>
      <button className="btn-ghost" onClick={() => setAskDel(true)} disabled={busy || !sel.length}>Delete</button></div>
    {r.isLoading && <PageLoader compact label="Loading" />}
    {r.error && <div className="alert">{(r.error as Error).message}</div>}
    {r.data && items.length === 0 && <div className="mh" style={{ padding: 12 }}>No application level catchwords for {lang} yet.</div>}
    {items.length > 0 && (<div className="um-scroll"><table className="grid-table"><thead><tr><th style={{ width: 30 }} /><th>Catchword</th><th>Status</th></tr></thead>
      <tbody>{items.map(w => (<tr key={w.id}><td><input type="checkbox" aria-label={`Select ${w.word}`} checked={sel.includes(w.id)} onChange={e => setSel(s => e.target.checked ? [...s, w.id] : s.filter(x => x !== w.id))} /></td>
        <td>{w.word}</td><td>{w.active ? <span className="catch-on">● Active</span> : <span className="catch-off">○ Inactive</span>}</td></tr>))}</tbody></table></div>)}
    <small className="mh">Application level catchwords belong to the whole system and are not listed under Catch management.</small>
    {askDel && <ConfirmDialog danger title="Delete catchwords?" confirmLabel="Delete" busy={busy} message={<>{sel.length} catchword(s) will be deleted.</>} onConfirm={remove} onCancel={() => setAskDel(false)} />}
  </>);
}

function WebPanel({ setMsg }: { setMsg: (m: Msg) => void }) {
  const { lang } = useLang();
  const qc = useQueryClient();
  const today = new Date(); const month = new Date(); month.setMonth(month.getMonth() - 1);
  const [from, setFrom] = useState(day(month)); const [to, setTo] = useState(day(today));
  const [page, setPage] = useState(1);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setPage(1); }, [from, to, lang]);
  const ok = !!from && !!to && from <= to;
  const r = useQuery({ queryKey: ['po-web', lang, from, to, page], queryFn: () => api.webHistory(lang, from, to, page), enabled: ok, placeholderData: p => p });
  const pages = Math.max(1, Math.ceil((r.data?.total ?? 0) / (r.data?.pageSize ?? 100)));
  async function remove() {
    setBusy(true);
    try { const x = await api.deleteWebHistory(from, to); await qc.invalidateQueries({ queryKey: ['po-web'] }); setMsg({ ok: true, t: `${x.removed} access record(s) deleted.` }); }
    catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); setStep(0); }
  }
  return (<>
    <div className="po-bar">
      <label>From&nbsp;<input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} /></label>
      <label>To&nbsp;<input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} /></label>
      <span className="sp" /><button className="btn-ghost" disabled={!ok || !r.data?.hits} onClick={() => setStep(1)}>Delete history…</button></div>
    {!ok && <div className="alert">Select a valid date range.</div>}
    {r.isLoading && ok && <PageLoader compact label="Loading" />}
    {r.error && <div className="alert">{(r.error as Error).message}</div>}
    {r.data && r.data.items.length === 0 && <div className="mh" style={{ padding: 12 }}>No web access in this period.</div>}
    {r.data && r.data.items.length > 0 && (<>
      <div className="mh">{r.data.hits} access(es) to {r.data.total} document(s)</div>
      <div className="um-scroll"><table className="grid-table"><thead><tr><th>ID</th><th>Document</th><th>Accesses</th><th>Last access</th></tr></thead>
        <tbody>{r.data.items.map(x => <tr key={x.id}><td>{x.id}</td><td>{x.name}</td><td>{x.hits}</td><td>{fmt(x.last)}</td></tr>)}</tbody></table></div></>)}
    {pages > 1 && (<div className="catch-pager"><button className="btn-ghost" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>‹ Previous</button><span>Page {page} of {pages}</span>
      <button className="btn-ghost" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next ›</button></div>)}
    {step === 1 && <ConfirmDialog danger title="Delete the web history?" confirmLabel="Continue" message={<>All web access records from <b>{from}</b> to <b>{to}</b> (all languages) will be deleted.</>} onConfirm={() => setStep(2)} onCancel={() => setStep(0)} />}
    {step === 2 && <ConfirmDialog danger title="Really delete?" confirmLabel="Delete permanently" busy={busy} message={<>This cannot be undone. Delete the web history of {from} – {to}?</>} onConfirm={remove} onCancel={() => setStep(0)} />}
  </>);
}

/** Frozen / Defrozen (manual p. 163-167): the feature is off until Config EnableFrozen = 1. "Do not expire" (LDSIsEnableDoNotExpire) is needed for the expiry options. */
function FrozenPanel({ setMsg }: { setMsg: (m: Msg) => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['frozen-options'], queryFn: api.frozenOptions });
  const [on, setOn] = useState(false); const [dne, setDne] = useState(false); const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data) { setOn(q.data.enabled); setDne(q.data.doNotExpire); } }, [q.data]);
  const dirty = !!q.data && (on !== q.data.enabled || dne !== q.data.doNotExpire);
  async function save() {
    setBusy(true);
    try { await api.setFrozenOptions(on, dne); await qc.invalidateQueries({ queryKey: ['frozen-options'] }); setMsg({ ok: true, t: on ? 'Frozen / Defrozen is switched on. Right-click a published, released or expired document.' : 'Frozen / Defrozen is switched off.' }); }
    catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); }
  }
  if (q.isLoading) return <PageLoader compact label="Loading" />;
  return (
    <div style={{ display: 'grid', gap: 14, maxWidth: 640 }}>
      <Switch checked={on} onChange={setOn} label="❄️ Enable Frozen / Defrozen" desc="Adds “Frozen” and “Defrozen” to the right-click menu of documents (right: Admin or Admin document)." />
      <Switch checked={dne} onChange={setDne} label="Enable “Do not expire”" desc="Lets administrators switch off the expiry of a document. Frozen documents never expire." />
      <div className="fx-usage"><div className="top"><b>How it works</b></div>
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6, fontSize: 13 }}>
          <li><b>Frozen</b>: for documents that were valid in the past and must stay available. Status Frozen, version 999.999.999, “do not expire” for good.</li>
          <li>The previous version goes to the archive history, the document is published again and an e-mail popup lets you inform everybody.</li>
          <li>A frozen document cannot be changed. <b>Defrozen</b> brings it back to Edit with the last real version + 1.</li>
          <li>Several documents: select them in the list (Ctrl/Shift), right-click and choose Frozen or Defrozen.</li></ul></div>
      <div><button className="btn-primary" style={{ width: 'auto' }} onClick={save} disabled={busy || !dirty}>{busy ? <Spinner /> : 'Save'}</button></div>
    </div>
  );
}
