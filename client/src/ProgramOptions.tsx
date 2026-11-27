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
import ViewOptions from './components/ViewOptions';
import './components/progopts.css';
import { tr } from './i18n';

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

type Tab = 'view' | 'server' | 'admin';
/** Options > Program options (manual p. 33 and 91-92; legacy "MS LDS-Program-options" window): View tab (everybody: font, date, grid columns),
 *  Server tab (not built) and Admin tab (cards, needs the Administrator right). A card opens its panel on this page. */
export default function ProgramOptions() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>('view');
  const [panel, setPanel] = useState<Panel>(null);
  const [msg, setMsg] = useState<Msg>(null);
  if (me.isLoading) return <PageLoader label={tr('Loading')} />;
  const admin = !!me.data?.isAdmin;
  const card = CARDS.find(c => c.id === panel);
  const TABS: { id: Tab; label: string; icon: string }[] = [{ id: 'view', label: tr('View'), icon: '👁️' }, { id: 'server', label: tr('Server'), icon: '🖥️' }, { id: 'admin', label: tr('Admin'), icon: '🛡️' }];
  const sub = tab === 'admin' ? (card ? card.title : tr('Administration of the application')) : tab === 'view' ? tr('Fonts, date format and grid columns') : tr('Server settings');
  return (
    <div className="um">
      <PageHero icon={<IconSliders />} title={tr('Program options')} sub={sub} chips={[{ n: TABS.find(t => t.id === tab)!.label, label: 'tab' }]} />
      <div className="card" style={{ padding: 16 }}>
        <div className="po-tabs po-noprint" role="tablist">
          {TABS.map(t => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => { setTab(t.id); setPanel(null); }}>
              <span aria-hidden>{t.icon}</span>{t.label}{t.id === 'admin' && !admin && <small title={tr('Administrators only')}>🔒</small>}</button>))}
        </div>
        {tab === 'view' && <ViewOptions onDone={t => setMsg({ ok: true, t })} />}
        {tab === 'server' && <div className="po-soon"><span aria-hidden>🖥️</span><b>{tr('Server settings')}</b><p>{tr('The server settings of the legacy program are managed on the server in the web version (appsettings and environment variables).')}</p></div>}
        {tab === 'admin' && !admin && <div className="po-soon"><span aria-hidden>🔒</span><b>{tr('Administrators only')}</b><p>{tr('The Admin tab is only available to administrators.')}</p></div>}
        {tab === 'admin' && admin && !panel && (<>
          <div className="po-grid">
            {CARDS.map(c => (
              <button key={c.id} className="po-card" onClick={() => setPanel(c.id)}>
                <span className="po-ico" aria-hidden="true">{c.icon}</span><h3>{c.title}</h3><p>{c.text}</p></button>))}
          </div>
          <div className="modal-foot" style={{ marginTop: 14 }}><button className="btn-ghost" onClick={() => nav('/documents')}>{tr('Close')}</button></div>
        </>)}
        {tab === 'admin' && admin && panel && (<>
          <div className="po-crumb po-noprint">
            <button className="po-back" onClick={() => setPanel(null)} aria-label={tr('Back to the cards')}><span className="po-back-arr" aria-hidden>‹</span><span>{tr('Back to the cards')}</span></button>
            <nav className="po-trail" aria-label={tr('Breadcrumb')}><span>{tr('Program options')}</span><i>›</i><span>{tr('Admin')}</span><i>›</i><b>{card?.title}</b></nav>
            <span className="po-crumb-ico" aria-hidden>{card?.icon}</span>
          </div>
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
    <div className="po-bar"><input value={text} onChange={e => setText(e.target.value)} placeholder={tr('Search by name or ID…')} aria-label={tr('Search deleted documents')} />
      <span className="mh">{r.data ? tr('{0} deleted document(s) in {1}', r.data.total, lang) : ''}</span></div>
    {r.isLoading && <PageLoader compact label={tr('Loading')} />}
    {r.error && <div className="alert">{(r.error as Error).message}</div>}
    {r.data && r.data.items.length === 0 && <div className="mh" style={{ padding: 12 }}>{tr('No deleted documents.')}</div>}
    {r.data && r.data.items.length > 0 && (
      <div className="um-scroll"><table className="grid-table"><thead><tr><th>{tr('ID')}</th><th>{tr('Document')}</th><th>{tr('Version')}</th><th>{tr('Type')}</th><th>{tr('Deleted on')}</th><th>{tr('Deleted by')}</th></tr></thead>
        <tbody>{r.data.items.map(d => <tr key={d.id}><td>{d.id}</td><td>{d.name}</td><td>{d.version}</td><td>{d.type}</td><td>{fmt(d.deleted)}</td><td>{d.deletedBy}</td></tr>)}</tbody></table></div>)}
    {pages > 1 && (<div className="catch-pager"><button className="btn-ghost" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>{tr('‹ Previous')}</button><span>{tr('Page')}{' '}{page} {tr('of')}{' '}{pages}</span>
      <button className="btn-ghost" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>{tr('Next ›')}</button></div>)}
  </>);
}

function LinksPanel() {
  const { lang } = useLang();
  const [type, setType] = useState('all');
  const r = useQuery({ queryKey: ['po-links', lang, type], queryFn: () => api.brokenLinks(lang, type), gcTime: 0 });
  return (<>
    <div className="po-bar">
      <label>{tr('Link type')}<select value={type} onChange={e => setType(e.target.value)}><option value="all">{tr('All')}</option><option value="int">{tr('Internal')}</option><option value="net">{tr('Network')}</option></select></label>
      <span className="sp" /><button className="btn-ghost po-noprint" onClick={() => window.print()} disabled={!r.data?.items.length}>{tr('Print')}</button></div>
    {r.isFetching && <PageLoader compact label={tr('Checking the links')} />}
    {r.error && <div className="alert">{(r.error as Error).message}</div>}
    {r.data && !r.isFetching && r.data.items.length === 0 && <div className="mh" style={{ padding: 12 }}>{tr('No broken links found.')}</div>}
    {r.data && !r.isFetching && r.data.items.length > 0 && (
      <div className="um-scroll"><table className="grid-table"><thead><tr><th>{tr('Document')}</th><th>{tr('Links to')}</th><th>{tr('Problem')}</th></tr></thead>
        <tbody>{r.data.items.map((l, i) => <tr key={i}><td>#{l.id} {l.name}</td><td>{l.targetId > 0 ? `#${l.targetId} ` : ''}{l.target}</td><td>{l.error}</td></tr>)}</tbody></table></div>)}
    <small className="mh">{tr('Internal: links to documents that are missing, not shown on the web, expired or never released. Network: UNC paths the server cannot reach.')}</small>
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
    setForm(null); return f.id === null ? tr('Application level tag created.') : tr('Application level tag saved.');
  });
  const remove = () => run(async () => { await api.deleteAppTag(del!.id, lang); setDel(null); return tr('Application level tag deleted.'); });
  const max = r.data?.maxDescription ?? 21, maxR = r.data?.maxReplacement ?? 50;
  return (<>
    <div className="po-bar"><button className="btn-primary" onClick={() => setForm({ id: null, desc: '', repl: '' })}>{tr('+ New application level tag')}</button>
      <button className="btn-ghost" onClick={() => setHist(v => !v)}>{hist ? tr('Hide history') : tr('History')}</button>
      <span className="mh">{tr('Tags are written as $$description$$ and are replaced by the replacement text.')}</span></div>
    {r.isLoading && <PageLoader compact label={tr('Loading')} />}
    {r.error && <div className="alert">{(r.error as Error).message}</div>}
    {r.data && r.data.items.length === 0 && <div className="mh" style={{ padding: 12 }}>{tr('No application level tags for')}{' '}{lang} {tr('yet.')}</div>}
    {r.data && r.data.items.length > 0 && (
      <table className="grid-table"><thead><tr><th>{tr('Tag')}</th><th>{tr('Replacement')}</th><th style={{ width: 150 }} /></tr></thead>
        <tbody>{r.data.items.map(t => (<tr key={t.id}><td><code>{t.tag}</code></td><td>{t.replacement}</td>
          <td><button className="btn-ghost" onClick={() => setForm({ id: t.id, desc: t.description, repl: t.replacement })}>{tr('Edit')}</button> <button className="btn-ghost" onClick={() => setDel(t)}>{tr('Delete')}</button></td></tr>))}</tbody></table>)}
    {hist && (<div style={{ marginTop: 14 }}>
      <b>{tr('History')}</b>{h.isLoading && <Spinner />}
      {h.data && h.data.length === 0 && <div className="mh">{tr('No history.')}</div>}
      {h.data && h.data.length > 0 && (<div className="um-scroll"><table className="grid-table"><thead><tr><th>{tr('Tag')}</th><th>{tr('Replacement')}</th><th>{tr('Created')}</th><th>{tr('By')}</th><th>{tr('Changed / removed')}</th><th>{tr('State')}</th></tr></thead>
        <tbody>{h.data.map(x => <tr key={x.sNo}><td><code>{x.name}</code></td><td>{x.replacement}</td><td>{fmt(x.created)}</td><td>{x.createdBy}</td><td>{fmt(x.modified)}</td><td>{x.current ? tr('Current') : tr('Old')}</td></tr>)}</tbody></table></div>)}</div>)}
    {form && (
      <div className="modal-back" onMouseDown={() => !busy && setForm(null)}>
        <div className="modal" role="dialog" aria-label={tr('Application level tag')} onMouseDown={e => e.stopPropagation()}>
          <div className="modal-head"><h3>{form.id === null ? tr('New application level tag') : tr('Edit application level tag')}</h3><button className="x" onClick={() => setForm(null)} aria-label={tr('Close')}>✕</button></div>
          <div className="po-form">
            <label className="mf">{tr('Tag Description')}<input autoFocus value={form.desc} maxLength={max} onChange={e => setForm({ ...form, desc: e.target.value })} /></label>
            <label className="mf">{tr('Replacement')}<input value={form.repl} maxLength={maxR} onChange={e => setForm({ ...form, repl: e.target.value })} /></label>
            <small className="mh">{tr('Tag:')}{' '}<code>{`$$${form.desc.trim() || '…'}$$`}</code></small>
          </div>
          <div className="modal-foot"><button className="btn-ghost" onClick={() => setForm(null)} disabled={busy}>{tr('Cancel')}</button>
            <button className="btn-primary" onClick={save} disabled={busy || !form.desc.trim() || !form.repl.trim()}>{busy ? <Spinner /> : tr('Save')}</button></div>
        </div></div>)}
    {del && <ConfirmDialog danger title={tr('Delete the tag?')} confirmLabel={tr('Delete')} busy={busy} message={<>{tr('The tag')}{' '}<b>{del.tag}</b> {tr('will be removed. Documents that still contain it keep the text unreplaced.')}</>} onConfirm={remove} onCancel={() => setDel(null)} />}
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
    <div className="po-bar"><input value={text} onChange={e => setText(e.target.value)} maxLength={120} placeholder={tr('New catchwords (separate with space, comma or ;)')} aria-label={tr('New catchwords')} style={{ minWidth: 280 }}
      onKeyDown={e => { if (e.key === 'Enter' && text.trim() && !busy) add(); }} />
      <button className="btn-primary" onClick={add} disabled={busy || !text.trim()}>{tr('Create')}</button><span className="sp" />
      <button className="btn-ghost" onClick={() => setState(true)} disabled={busy || !sel.length}>{tr('Activate')}</button>
      <button className="btn-ghost" onClick={() => setState(false)} disabled={busy || !sel.length}>{tr('Deactivate')}</button>
      <button className="btn-ghost" onClick={() => setAskDel(true)} disabled={busy || !sel.length}>{tr('Delete')}</button></div>
    {r.isLoading && <PageLoader compact label={tr('Loading')} />}
    {r.error && <div className="alert">{(r.error as Error).message}</div>}
    {r.data && items.length === 0 && <div className="mh" style={{ padding: 12 }}>{tr('No application level catchwords for')}{' '}{lang} {tr('yet.')}</div>}
    {items.length > 0 && (<div className="um-scroll"><table className="grid-table"><thead><tr><th style={{ width: 30 }} /><th>{tr('Catchword')}</th><th>{tr('Status')}</th></tr></thead>
      <tbody>{items.map(w => (<tr key={w.id}><td><input type="checkbox" aria-label={tr('Select {0}', w.word)} checked={sel.includes(w.id)} onChange={e => setSel(s => e.target.checked ? [...s, w.id] : s.filter(x => x !== w.id))} /></td>
        <td>{w.word}</td><td>{w.active ? <span className="catch-on">{tr('● Active')}</span> : <span className="catch-off">{tr('○ Inactive')}</span>}</td></tr>))}</tbody></table></div>)}
    <small className="mh">{tr('Application level catchwords belong to the whole system and are not listed under Catch management.')}</small>
    {askDel && <ConfirmDialog danger title={tr('Delete catchwords?')} confirmLabel={tr('Delete')} busy={busy} message={<>{sel.length} {tr('catchword(s) will be deleted.')}</>} onConfirm={remove} onCancel={() => setAskDel(false)} />}
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
    try { const x = await api.deleteWebHistory(from, to); await qc.invalidateQueries({ queryKey: ['po-web'] }); setMsg({ ok: true, t: tr('{0} access record(s) deleted.', x.removed) }); }
    catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); setStep(0); }
  }
  return (<>
    <div className="po-bar">
      <label>{tr('From')}<input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} /></label>
      <label>{tr('To')}<input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} /></label>
      <span className="sp" /><button className="btn-ghost" disabled={!ok || !r.data?.hits} onClick={() => setStep(1)}>{tr('Delete history…')}</button></div>
    {!ok && <div className="alert">{tr('Select a valid date range.')}</div>}
    {r.isLoading && ok && <PageLoader compact label={tr('Loading')} />}
    {r.error && <div className="alert">{(r.error as Error).message}</div>}
    {r.data && r.data.items.length === 0 && <div className="mh" style={{ padding: 12 }}>{tr('No web access in this period.')}</div>}
    {r.data && r.data.items.length > 0 && (<>
      <div className="mh">{r.data.hits} {tr('access(es) to')}{' '}{r.data.total} {tr('document(s)')}</div>
      <div className="um-scroll"><table className="grid-table"><thead><tr><th>{tr('ID')}</th><th>{tr('Document')}</th><th>{tr('Accesses')}</th><th>{tr('Last access')}</th></tr></thead>
        <tbody>{r.data.items.map(x => <tr key={x.id}><td>{x.id}</td><td>{x.name}</td><td>{x.hits}</td><td>{fmt(x.last)}</td></tr>)}</tbody></table></div></>)}
    {pages > 1 && (<div className="catch-pager"><button className="btn-ghost" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>{tr('‹ Previous')}</button><span>{tr('Page')}{' '}{page} {tr('of')}{' '}{pages}</span>
      <button className="btn-ghost" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>{tr('Next ›')}</button></div>)}
    {step === 1 && <ConfirmDialog danger title={tr('Delete the web history?')} confirmLabel={tr('Continue')} message={<>{tr('All web access records from')}{' '}<b>{from}</b> {tr('to')}{' '}<b>{to}</b> {tr('(all languages) will be deleted.')}</>} onConfirm={() => setStep(2)} onCancel={() => setStep(0)} />}
    {step === 2 && <ConfirmDialog danger title={tr('Really delete?')} confirmLabel={tr('Delete permanently')} busy={busy} message={<>{tr('This cannot be undone. Delete the web history of')}{' '}{from} – {to}?</>} onConfirm={remove} onCancel={() => setStep(0)} />}
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
    try { await api.setFrozenOptions(on, dne); await qc.invalidateQueries({ queryKey: ['frozen-options'] }); setMsg({ ok: true, t: on ? tr('Frozen / Defrozen is switched on. Right-click a published, released or expired document.') : tr('Frozen / Defrozen is switched off.') }); }
    catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); }
  }
  if (q.isLoading) return <PageLoader compact label={tr('Loading')} />;
  return (
    <div style={{ display: 'grid', gap: 14, maxWidth: 640 }}>
      <Switch checked={on} onChange={setOn} label={tr('❄️ Enable Frozen / Defrozen')} desc={tr('Adds “Frozen” and “Defrozen” to the right-click menu of documents (right: Admin or Admin document).')} />
      <Switch checked={dne} onChange={setDne} label={tr('Enable “Do not expire”')} desc={tr('Lets administrators switch off the expiry of a document. Frozen documents never expire.')} />
      <div className="fx-usage"><div className="top"><b>{tr('How it works')}</b></div>
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6, fontSize: 13 }}>
          <li><b>{tr('Frozen')}</b>{tr(': for documents that were valid in the past and must stay available. Status Frozen, version 999.999.999, “do not expire” for good.')}</li>
          <li>{tr('The previous version goes to the archive history, the document is published again and an e-mail popup lets you inform everybody.')}</li>
          <li>{tr('A frozen document cannot be changed.')}{' '}<b>{tr('Defrozen')}</b> {tr('brings it back to Edit with the last real version + 1.')}</li>
          <li>{tr('Several documents: select them in the list (Ctrl/Shift), right-click and choose Frozen or Defrozen.')}</li></ul></div>
      <div><button className="btn-primary" style={{ width: 'auto' }} onClick={save} disabled={busy || !dirty}>{busy ? <Spinner /> : tr('Save')}</button></div>
    </div>
  );
}
