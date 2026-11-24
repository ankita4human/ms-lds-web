import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, type DepItem } from './api';
import { useLang } from './LangContext';
import { useGroupTree } from './useGroupTree';
import { Spinner, PageLoader } from './components/Loader';
import ConfirmDialog from './components/ConfirmDialog';
import PageHero from './components/PageHero';
import Toast, { type ToastMsg } from './components/Toast';
import { StatusBadge } from './components/bits';
import { FolderPicker } from './components/DocDialogs';
import { IconDocs } from './components/Icons';

/** Options > Dependency (manual p. 83-85): documents that belong together. Changing one of them puts the others in Edit mode. */
export default function DependencyManagement() {
  const { lang } = useLang();
  const qc = useQueryClient();
  const nav = useNavigate();
  const list = useQuery({ queryKey: ['deps', lang], queryFn: () => api.dependencies(lang), enabled: !!lang });
  const [sel, setSel] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [rename, setRename] = useState(false);
  const [askDel, setAskDel] = useState(false);
  const [pick, setPick] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<ToastMsg>(null);
  const can = list.data?.canManage ?? false;
  const cur = list.data?.items.find(d => d.id === sel);
  const docs = useQuery({ queryKey: ['dep-docs', sel], queryFn: () => api.dependencyDocs(sel!), enabled: sel !== null });
  useEffect(() => { if (cur) setName(cur.name); }, [cur?.id, cur?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => Promise.all(['deps', 'dep-docs'].map(k => qc.invalidateQueries({ queryKey: [k] })));
  async function run(fn: () => Promise<void>) { setBusy(true); try { await fn(); } catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); } }
  const add = () => run(async () => {
    const all = list.data?.items.map(d => d.name) ?? [];
    let n = 'New dependency'; for (let i = 1; all.includes(n); i++) n = `New dependency (${i})`;
    const r = await api.createDependency(lang, n); await refresh(); setSel(r.id); setRename(true); setMsg({ ok: true, t: 'Dependency added. Give it a name and add documents.' });
  });
  const saveName = () => run(async () => { if (sel === null) return; await api.renameDependency(sel, name.trim()); await refresh(); setRename(false); setMsg({ ok: true, t: 'Saved.' }); });
  const del = () => run(async () => { if (sel === null) return; await api.deleteDependency(sel); await refresh(); setSel(null); setAskDel(false); setMsg({ ok: true, t: 'Dependency deleted.' }); });
  const removeDoc = (id: number) => run(async () => { if (sel === null) return; await api.removeDependencyDoc(sel, id); await refresh(); });

  const item = (d: DepItem) => (
    <div key={d.id} className={`fm-item ${sel === d.id ? 'sel' : ''}`} onClick={() => { setSel(d.id); setRename(false); }}>
      <span className="nm">{d.name}</span><small className="mh">{d.documents}</small>
    </div>);
  return (
    <div className="um">
      <PageHero icon={<IconDocs />} title="Dependency" sub="Documents that belong together: change one, the others go to Edit"
        chips={[{ n: list.data?.items.length ?? '–', label: 'dependencies' }, { n: list.data?.editChoice ? 'choose' : 'all', label: 'on edit' }]} />
      <div className="fm">
        <div className="card fm-list">
          <div className="fm-list-head"><b>Dependencies ({lang})</b>
            <span><button className="ico-btn add" title="Add dependency" aria-label="Add dependency" onClick={add} disabled={busy || !can}>＋</button>
              <button className="ico-btn del" title="Delete dependency" aria-label="Delete dependency" onClick={() => setAskDel(true)} disabled={busy || !can || sel === null}>−</button></span></div>
          {list.isLoading && <PageLoader compact label="Loading dependencies" />}
          {list.data?.items.map(item)}
          {list.data?.items.length === 0 && <div className="mh" style={{ padding: 10 }}>No dependencies in this language.</div>}
        </div>
        <div className="card fm-edit">
          {cur === undefined ? <div className="mh" style={{ padding: 20 }}>Select a dependency on the left or add a new one.{!can && ' You may view the dependencies but not change them (right "Management dependencies").'}</div> : (<>
            <fieldset className="fm-box"><legend>Dependency</legend>
              <div className="fm-top"><div className="fm-fields">
                <label className="fm-row">Name<input value={name} maxLength={50} onChange={e => { setName(e.target.value); setRename(true); }} disabled={!can} /></label>
                <small className="mh">Only documents in the original language ({lang}) can be added. When a dependent document is changed, the other documents of this dependency are put in Edit mode{list.data?.editChoice ? ' (you choose which ones)' : ''}.</small>
              </div>
                <div className="fm-btns">
                  <button className="btn-primary" onClick={saveName} disabled={busy || !can || !rename || !name.trim()}>{busy ? <Spinner /> : 'Save'}</button>
                  <button className="btn-ghost" onClick={() => setPick(true)} disabled={busy || !can}>Add documents…</button>
                  <button className="btn-ghost" onClick={() => nav('/documents')}>Close</button>
                </div></div>
            </fieldset>
            <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 380px)', border: '1px solid var(--line)', borderRadius: 12 }}>
              <table className="tbl" style={{ width: '100%' }}>
                <thead><tr><th>ID</th><th>Document</th><th>Version</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {docs.data?.items.map(d => (
                    <tr key={d.idDoc}><td>{d.idDoc}</td><td><b>{d.name}</b></td><td>{d.version}</td><td><StatusBadge id={d.status} name={d.statusName} /></td>
                      <td style={{ textAlign: 'right' }}><button className="ico-btn del" title="Remove from dependency" aria-label="Remove from dependency" onClick={() => removeDoc(d.idDoc)} disabled={busy || !can}>−</button></td></tr>))}
                  {docs.isLoading && <tr><td colSpan={5}><Spinner /> Loading…</td></tr>}
                  {docs.data && docs.data.items.length === 0 && <tr><td colSpan={5} className="mh" style={{ padding: 14 }}>No documents in this dependency yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </>)}
        </div>
      </div>
      {askDel && cur && <ConfirmDialog danger title="Delete dependency?" confirmLabel="Delete" busy={busy}
        message={<>The dependency <b>{cur.name}</b> is deleted. The documents themselves stay as they are.</>} onConfirm={del} onCancel={() => setAskDel(false)} />}
      {pick && sel !== null && <PickDocs depId={sel} lang={lang} have={new Set(docs.data?.items.map(d => d.idDoc))} onClose={() => setPick(false)}
        onDone={async m => { setPick(false); await refresh(); setMsg({ ok: true, t: m }); }} />}
      <Toast msg={msg} onClose={() => setMsg(null)} />
    </div>
  );
}

/** "Choose Group" window: pick a group or search by name / ID; documents of the selected language only. */
function PickDocs({ depId, lang, have, onClose, onDone }: { depId: number; lang: string; have: Set<number>; onClose: () => void; onDone: (m: string) => void }) {
  const tree = useGroupTree(lang);
  const [group, setGroup] = useState<number | null>(null);
  const [q, setQ] = useState(''); const [dq, setDq] = useState('');
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  useEffect(() => { const t = setTimeout(() => setDq(q), 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [busy, onClose]);
  const res = useQuery({ queryKey: ['dep-cand', lang, dq, group], queryFn: () => api.dependencyCandidates(lang, dq, group), enabled: group !== null || dq.trim().length > 0 });
  const toggle = (id: number) => setChosen(c => { const s = new Set(c); if (s.has(id)) s.delete(id); else s.add(id); return s; });
  async function go() {
    setBusy(true); setErr('');
    try { const r = await api.addDependencyDocs(depId, [...chosen]); onDone(`${r.added} document(s) added${r.skipped ? `, ${r.skipped} skipped` : ''}.`); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  return (
    <div className="modal-back" onMouseDown={() => !busy && onClose()}>
      <div className="modal grp-dlg" style={{ width: 760 }} role="dialog" aria-modal="true" aria-label="Choose documents" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head"><div><h3 style={{ margin: 0 }}>Choose Group</h3><div className="mh">Documents of language {lang}</div></div><button className="x" onClick={onClose} disabled={busy} aria-label="Close">✕</button></div>
        <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 12, minHeight: 320 }}>
          <div style={{ maxHeight: 360, overflow: 'auto' }}>{tree.data ? <FolderPicker groups={tree.data.groups} value={group} onChange={setGroup} /> : <PageLoader compact label="Loading groups" />}</div>
          <div style={{ display: 'grid', gap: 8, alignContent: 'start' }}>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search by name or ID…" aria-label="Search documents" style={{ padding: '8px 10px', border: '1px solid #d0d5dd', borderRadius: 10, font: 'inherit' }} />
            <div style={{ maxHeight: 300, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 10 }}>
              <table className="tbl" style={{ width: '100%', fontSize: 13 }}><tbody>
                {res.data?.map(d => { const inDep = have.has(d.idDoc); return (
                  <tr key={d.idDoc} style={inDep ? { opacity: .5 } : undefined}>
                    <td><input type="checkbox" disabled={inDep} checked={inDep || chosen.has(d.idDoc)} onChange={() => toggle(d.idDoc)} aria-label={`Select ${d.name}`} /></td>
                    <td>{d.idDoc}</td><td><b>{d.name}</b></td><td>{d.version}</td><td><StatusBadge id={d.status} name={d.statusName} /></td></tr>); })}
                {res.isFetching && <tr><td colSpan={5}><Spinner /> Searching…</td></tr>}
                {res.data?.length === 0 && <tr><td colSpan={5} className="mh" style={{ padding: 12 }}>No documents found.</td></tr>}
                {!res.data && !res.isFetching && <tr><td colSpan={5} className="mh" style={{ padding: 12 }}>Choose a group or type a name.</td></tr>}
              </tbody></table>
            </div>
            {err && <div className="alert" role="alert">{err}</div>}
          </div>
        </div>
        <div className="modal-foot">
          <small className="mh" style={{ marginRight: 'auto' }}>{chosen.size} selected</small>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Close</button>
          <button className="btn-primary" style={{ width: 'auto' }} onClick={go} disabled={busy || chosen.size === 0}>{busy ? <Spinner /> : 'Add'}</button>
        </div>
      </div>
    </div>
  );
}
