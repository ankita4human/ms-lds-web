import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, type DateRange, type FilterCriteria, type IdName } from './api';
import { useLang } from './LangContext';
import { Spinner, PageLoader } from './components/Loader';
import ConfirmDialog from './components/ConfirmDialog';
import { IconFilter } from './components/Icons';
import PageHero from './components/PageHero';
import Toast from './components/Toast';

type Tab = 'doc' | 'control' | 'other' | 'date';
const DATES: { key: 'created' | 'edited' | 'released' | 'published' | 'expired'; label: string }[] = [
  { key: 'created', label: 'Created date' }, { key: 'edited', label: 'Edit date' }, { key: 'released', label: 'Released date' },
  { key: 'published', label: 'Published date' }, { key: 'expired', label: 'Expired date' },
];
const today = () => new Date().toISOString().slice(0, 10);
const emptyRange = (): DateRange => ({ active: false, from: today(), to: today() });

function Pick({ label, value, onChange, options }: { label: string; value?: number; onChange: (v?: number) => void; options: IdName[] }) {
  return (
    <label className="fm-row">{label}
      <select value={value ?? ''} onChange={e => onChange(e.target.value ? Number(e.target.value) : undefined)}>
        <option value="">-</option>{options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </label>
  );
}

function Multi({ label, options, value, onChange }: { label: string; options: IdName[]; value: number[]; onChange: (v: number[]) => void }) {
  return (
    <div className="fm-row">{label}
      <div className="fm-multi" role="group" aria-label={label}>
        {options.map(o => (
          <label key={o.id}><input type="checkbox" checked={value.includes(o.id)}
            onChange={e => onChange(e.target.checked ? [...value, o.id] : value.filter(x => x !== o.id))} />{o.name}</label>
        ))}
      </div>
    </div>
  );
}

/** Options > Filter management (manual p. 73-81): create / change / delete filters with Document, Control, Other and Date Range criteria. */
export default function FilterManagement() {
  const { lang } = useLang();
  const qc = useQueryClient();
  const nav = useNavigate();
  const list = useQuery({ queryKey: ['filters'], queryFn: api.filters });
  const opts = useQuery({ queryKey: ['filter-opts', lang], queryFn: () => api.filterOptions(lang), enabled: !!lang, staleTime: 60_000 });
  const [selId, setSelId] = useState<number | 'new' | null>(null);
  const [name, setName] = useState(''); const [general, setGeneral] = useState(false); const [web, setWeb] = useState(false);
  const [c, setC] = useState<FilterCriteria>({});
  const [tab, setTab] = useState<Tab>('doc');
  const [askDel, setAskDel] = useState(false);
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);

  const head = useMemo(() => list.data?.find(f => f.idFilter === selId), [list.data, selId]);
  const editable = selId === 'new' || (head ? head.mine || head.general : false);
  const set = <K extends keyof FilterCriteria>(k: K, v: FilterCriteria[K]) => setC(p => ({ ...p, [k]: v }));
  const range = (k: typeof DATES[number]['key']): DateRange => c[k] ?? emptyRange();

  function startNew() { setSelId('new'); setName(''); setGeneral(false); setWeb(false); setC({}); setTab('doc'); setMsg(null); }
  useEffect(() => {
    if (typeof selId !== 'number') return;
    let live = true; setMsg(null);
    api.filter(selId).then(r => {
      if (!live) return;
      setName(r.head.name); setGeneral(r.head.general); setWeb(r.head.web); setC(r.criteria);
    }).catch(e => live && setMsg({ ok: false, t: (e as Error).message }));
    return () => { live = false; };
  }, [selId]);

  const body = () => ({ name: name.trim(), general, web: web && general, criteria: c, lang });
  async function run(fn: () => Promise<void>) { setBusy(true); setMsg(null); try { await fn(); } catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); } }
  const save = () => run(async () => {
    if (!name.trim()) throw new Error('Please enter a filter name.');
    const r = selId === 'new' ? await api.createFilter(body()) : await api.updateFilter(selId as number, body());
    await qc.invalidateQueries({ queryKey: ['filters'] }); await qc.invalidateQueries({ queryKey: ['docs'] });
    setSelId(r.idFilter); setMsg({ ok: true, t: 'Filter saved.' });
  });
  const remove = () => run(async () => {
    if (typeof selId !== 'number') return;
    await api.deleteFilter(selId);
    setAskDel(false);
    await qc.invalidateQueries({ queryKey: ['filters'] }); setSelId(null); setMsg({ ok: true, t: 'Filter deleted.' });
  });
  const verify = () => run(async () => { const r = await api.verifyFilter(body()); setMsg({ ok: true, t: `${r.count} document(s) match these criteria in ${lang}.` }); });

  const o = opts.data;
  return (
    <div className="um">
      <PageHero icon={<IconFilter />} title="Filter management" sub="Saved filters for the document list" chips={[{ n: list.data?.length ?? '–', label: 'filters' }, { n: list.data?.filter(x => x.general).length ?? '–', label: 'general' }]} />
      <div className="fm">
      <div className="card fm-list">
        <div className="fm-list-head"><b>All filters</b>
          <span><button className="ico-btn add" title="Add filter" aria-label="Add filter" onClick={startNew}>＋</button>
            <button className="ico-btn del" title="Delete filter" aria-label="Delete filter" onClick={() => setAskDel(true)} disabled={busy || typeof selId !== 'number' || !editable}>−</button></span>
        </div>
        {list.isLoading && <PageLoader compact label="Loading filters" />}
        {list.data?.map(f => (
          <div key={f.idFilter} className={`fm-item ${selId === f.idFilter ? 'sel' : ''}`} onClick={() => setSelId(f.idFilter)}>
            <span className="fm-av f"><IconFilter /></span><span className="nm">{f.name}</span>{f.general && <i title="General filter">🌐</i>}
          </div>
        ))}
        {list.data?.length === 0 && <div className="mh" style={{ padding: 10 }}>No filters yet. Click ＋ to add one.</div>}
      </div>

      <div className="card fm-edit">
        {selId === null ? <div className="mh" style={{ padding: 20 }}>Select a filter on the left or add a new one.</div> : (<>
          <fieldset className="fm-box"><legend>Filter</legend>
            <div className="fm-top">
              <div className="fm-fields">
                <label className="fm-row">Name<input value={name} maxLength={100} onChange={e => setName(e.target.value)} disabled={!editable} /></label>
                <label className="fm-chk"><input type="checkbox" checked={general} disabled={!editable}
                  onChange={e => { setGeneral(e.target.checked); if (!e.target.checked) setWeb(false); }} />General filter (shown to all users)</label>
                <label className="fm-chk"><input type="checkbox" checked={web} disabled={!editable || !general} onChange={e => setWeb(e.target.checked)} />Web publishing (only for general filters)</label>
              </div>
              <div className="fm-btns">
                <button className="btn-primary" onClick={save} disabled={busy || !editable}>{busy ? <Spinner /> : 'Save'}</button>
                <button className="btn-ghost" onClick={verify} disabled={busy}>Verify</button>
                {typeof selId === 'number' && <button className="btn-ghost" onClick={() => nav(`/documents?filter=${selId}`)}>Show documents</button>}
              </div>
            </div>
          </fieldset>
          {opts.isLoading || !o ? <PageLoader compact label="Loading options" /> : (<>
            <div className="fm-tabs" role="tablist">
              {([['doc', 'Document'], ['control', 'Control'], ['other', 'Other'], ['date', 'Date Range']] as [Tab, string][]).map(([k, l]) =>
                <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
            </div>
            <div className="fm-pane" style={editable ? undefined : { pointerEvents: 'none', opacity: .6 }}>
              {tab === 'doc' && (<>
                <label className="fm-row">Document name<input value={c.docName ?? ''} onChange={e => set('docName', e.target.value)} /></label>
                <label className="fm-row">Document ID<input value={c.docId ?? ''} placeholder="e.g. 121 or 121;130" onChange={e => set('docId', e.target.value)} /></label>
                <Multi label="Document status" options={o.statuses} value={c.statuses ?? []} onChange={v => set('statuses', v)} />
                <Multi label="Document type" options={o.types} value={c.types ?? []} onChange={v => set('types', v)} />
                <label className="fm-row">Search text in document<input value={c.searchText ?? ''} onChange={e => set('searchText', e.target.value)} placeholder="words in the document name" /></label>
                <Pick label="Special filters" value={c.special} onChange={v => set('special', v)} options={o.specials} />
              </>)}
              {tab === 'control' && (<>
                <Pick label="Author" value={c.author} onChange={v => set('author', v)} options={o.accounts} />
                <Pick label="Editor" value={c.editor} onChange={v => set('editor', v)} options={o.accounts} />
                <Pick label="Verifier" value={c.verifier} onChange={v => set('verifier', v)} options={o.accounts} />
                <Pick label="Releaser" value={c.releaser} onChange={v => set('releaser', v)} options={o.accounts} />
                <Pick label="Publisher" value={c.publisher} onChange={v => set('publisher', v)} options={o.accounts} />
                <Pick label="Distributor" value={c.distributor} onChange={v => set('distributor', v)} options={o.mailLists} />
                <Pick label="Process owner" value={c.processOwner} onChange={v => set('processOwner', v)} options={o.owners} />
              </>)}
              {tab === 'other' && (<>
                <label className="fm-row">Application
                  <select value={c.application ?? ''} onChange={e => set('application', e.target.value || undefined)}>
                    <option value="">-</option>{o.extensions.map(x => <option key={x} value={x}>{x}</option>)}
                  </select></label>
                <label className="fm-row">Language
                  <select value={c.language ?? ''} onChange={e => set('language', e.target.value || undefined)}>
                    <option value="">-</option>{o.languages.map(x => <option key={x.id} value={x.id}>{x.id} – {x.name}</option>)}
                  </select></label>
                <label className="fm-row">Group
                  <select value={c.group ?? ''} onChange={e => set('group', e.target.value ? Number(e.target.value) : undefined)}>
                    <option value="">-</option>{o.groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select></label>
                <label className="fm-row">Group number<input value={c.groupNumber ?? ''} placeholder="e.g. G45" onChange={e => set('groupNumber', e.target.value)} /></label>
                <label className="fm-chk"><input type="checkbox" checked={!!c.includeSubgroups} disabled={!c.group || !!c.unlinked} onChange={e => set('includeSubgroups', e.target.checked)} />Include subgroups</label>
                <label className="fm-chk"><input type="checkbox" checked={!!c.unlinked} disabled={!c.group} onChange={e => set('unlinked', e.target.checked)} />Unlinked documents (not in the selected group)</label>
              </>)}
              {tab === 'date' && (<>
                <p className="mh">Date range filters are inactive by default; tick “Activate” to use one. All active ranges work together with the other criteria.</p>
                {DATES.map(d => {
                  const r = range(d.key);
                  return (
                    <div key={d.key} className="fm-date">
                      <label className="fm-chk"><input type="checkbox" checked={r.active} onChange={e => set(d.key, { ...r, active: e.target.checked })} /><b>{d.label}</b> – Activate</label>
                      <label>From<input type="date" value={r.from} disabled={!r.active} onChange={e => set(d.key, { ...r, from: e.target.value })} /></label>
                      <label>To<input type="date" value={r.to} disabled={!r.active} onChange={e => set(d.key, { ...r, to: e.target.value })} /></label>
                    </div>
                  );
                })}
              </>)}
            </div>
          </>)}
        </>)}
      </div>
      {askDel && <ConfirmDialog danger title="Delete filter?" confirmLabel="Delete" busy={busy}
        message={<>The filter <b>{name}</b> will be removed for {general ? 'all users' : 'you'}. This cannot be undone.</>}
        onConfirm={async () => { await remove(); setAskDel(false); }} onCancel={() => setAskDel(false)} />}
      </div>
      <Toast msg={msg} onClose={() => setMsg(null)} />
    </div>
  );
}
