import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, type DateRange, type FilterCriteria, type FilterHead, type FilterOptions, type IdName } from './api';
import { useLang } from './LangContext';
import { Spinner, PageLoader } from './components/Loader';
import ConfirmDialog from './components/ConfirmDialog';
import { IconFilter } from './components/Icons';
import PageHero from './components/PageHero';
import Toast, { type ToastMsg } from './components/Toast';
import { Combo, Pills, SaveBar, Switch, useSaveShortcut } from './components/FormBits';
import { tr } from './i18n';

type Tab = 'doc' | 'control' | 'other' | 'date';
type DKey = 'created' | 'edited' | 'released' | 'published' | 'expired';
const DATES: { key: DKey; label: string; ico: string }[] = [
  { key: 'created', label: 'Created date', ico: '🆕' }, { key: 'edited', label: 'Edit date', ico: '✏️' }, { key: 'released', label: 'Released date', ico: '✅' },
  { key: 'published', label: 'Published date', ico: '🚀' }, { key: 'expired', label: 'Expired date', ico: '⏳' },
];
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => ymd(new Date());
const emptyRange = (): DateRange => ({ active: false, from: today(), to: today() });
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };
const RANGES: { label: string; make: () => { from: string; to: string } }[] = [
  { label: 'Today', make: () => ({ from: today(), to: today() }) },
  { label: 'Last 7 days', make: () => ({ from: daysAgo(7), to: today() }) },
  { label: 'Last 30 days', make: () => ({ from: daysAgo(30), to: today() }) },
  { label: 'This month', make: () => { const d = new Date(); return { from: ymd(new Date(d.getFullYear(), d.getMonth(), 1)), to: today() }; } },
  { label: 'This year', make: () => ({ from: `${new Date().getFullYear()}-01-01`, to: today() }) },
];
const TAB_ICO: Record<Tab, string> = { doc: '📄', control: '👤', other: '⚙️', date: '📅' };
const TAB_LBL: Record<Tab, string> = { doc: 'Document', control: 'People', other: 'Other', date: 'Dates' };

type Chip = { key: string; tab: Tab; text: string; clear: () => void };

function chipsOf(c: FilterCriteria, o: FilterOptions | undefined, set: (p: Partial<FilterCriteria>) => void): Chip[] {
  const out: Chip[] = [];
  const nm = (a: IdName[] | undefined, id?: number) => a?.find(x => x.id === id)?.name ?? String(id);
  const names = (a: IdName[] | undefined, ids: number[]) => ids.map(i => nm(a, i)).join(', ');
  if (c.docName) out.push({ key: 'docName', tab: 'doc', text: tr('Name: {0}', c.docName), clear: () => set({ docName: undefined }) });
  if (c.docId) out.push({ key: 'docId', tab: 'doc', text: tr('ID: {0}', c.docId), clear: () => set({ docId: undefined }) });
  if (c.statuses?.length) out.push({ key: 'statuses', tab: 'doc', text: tr('Status: {0}', names(o?.statuses, c.statuses)), clear: () => set({ statuses: [] }) });
  if (c.types?.length) out.push({ key: 'types', tab: 'doc', text: tr('Type: {0}', names(o?.types, c.types)), clear: () => set({ types: [] }) });
  if (c.searchText) out.push({ key: 'searchText', tab: 'doc', text: tr('Text: {0}', c.searchText), clear: () => set({ searchText: undefined }) });
  if (c.special) out.push({ key: 'special', tab: 'doc', text: tr('Special: {0}', nm(o?.specials, c.special)), clear: () => set({ special: undefined }) });
  const ppl: [keyof FilterCriteria, string, IdName[] | undefined][] = [['author', tr('Author'), o?.accounts], ['editor', tr('Editor'), o?.accounts], ['verifier', tr('Verifier'), o?.accounts], ['releaser', tr('Releaser'), o?.accounts], ['publisher', tr('Publisher'), o?.accounts], ['distributor', tr('Distributor'), o?.mailLists], ['processOwner', tr('Process owner'), o?.owners]];
  for (const [k, l, a] of ppl) if (c[k] !== undefined) out.push({ key: k, tab: 'control', text: `${l}: ${nm(a, c[k] as number)}`, clear: () => set({ [k]: undefined }) });
  if (c.application) out.push({ key: 'application', tab: 'other', text: tr('Application: {0}', c.application), clear: () => set({ application: undefined }) });
  if (c.language) out.push({ key: 'language', tab: 'other', text: tr('Language: {0}', c.language), clear: () => set({ language: undefined }) });
  if (c.group) out.push({ key: 'group', tab: 'other', text: tr('Group: {0}{1}', o?.groups.find(g => g.id === c.group)?.name ?? c.group, c.unlinked ? tr(' (not in)') : c.includeSubgroups ? tr(' + subgroups') : ''), clear: () => set({ group: undefined, includeSubgroups: false, unlinked: false }) });
  if (c.groupNumber) out.push({ key: 'groupNumber', tab: 'other', text: tr('Group no.: {0}', c.groupNumber), clear: () => set({ groupNumber: undefined }) });
  for (const d of DATES) { const r = c[d.key]; if (r?.active) out.push({ key: d.key, tab: 'date', text: `${d.label}: ${r.from} → ${r.to}`, clear: () => set({ [d.key]: { ...r, active: false } }) }); }
  return out;
}

/** Options > Filter management (manual p. 73-81): saved filters with Document, People, Other and Date criteria. */
export default function FilterManagement() {
  const { lang } = useLang();
  const qc = useQueryClient();
  const nav = useNavigate();
  const list = useQuery({ queryKey: ['filters'], queryFn: api.filters });
  const opts = useQuery({ queryKey: ['filter-opts', lang], queryFn: () => api.filterOptions(lang), enabled: !!lang, staleTime: 60_000 });
  const [selId, setSelId] = useState<number | 'new' | null>(null);
  const [name, setName] = useState(''); const [general, setGeneral] = useState(false); const [web, setWeb] = useState(false);
  const [c, setC] = useState<FilterCriteria>({});
  const [base, setBase] = useState('');
  const [tab, setTab] = useState<Tab>('doc');
  const [q, setQ] = useState(''); const [seg, setSeg] = useState<'all' | 'mine' | 'general' | 'web'>('all');
  const [askDel, setAskDel] = useState(false);
  const [pending, setPending] = useState<number | 'new' | null | undefined>(undefined);   // selection waiting for "discard changes?"
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<ToastMsg>(null);
  const [count, setCount] = useState<number | null>(null); const [counting, setCounting] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const snapshot = (n = name, g = general, w = web, cc = c) => JSON.stringify({ n, g, w, cc });
  const dirty = selId !== null && snapshot() !== base;
  const head = useMemo(() => list.data?.find(f => f.idFilter === selId), [list.data, selId]);
  const editable = selId === 'new' || (head ? head.mine || head.general : false);
  const o = opts.data;
  const mergeC = (p: Partial<FilterCriteria>) => setC(prev => ({ ...prev, ...p }));
  const set = <K extends keyof FilterCriteria>(k: K, v: FilterCriteria[K]) => setC(p => ({ ...p, [k]: v }));
  const range = (k: DKey): DateRange => c[k] ?? emptyRange();
  const chips = useMemo(() => chipsOf(c, o, mergeC), [c, o]);   // eslint-disable-line react-hooks/exhaustive-deps
  const tabCount = (t: Tab) => chips.filter(x => x.tab === t).length;

  function open(id: number | 'new' | null) {
    if (dirty && id !== selId) { setPending(id); return; }
    go(id);
  }
  function go(id: number | 'new' | null) {
    setPending(undefined); setMsg(null); setCount(null); setTab('doc');
    setSelId(id);
    if (id === 'new') { setName(''); setGeneral(false); setWeb(false); setC({}); setBase(snapshot('', false, false, {})); setTimeout(() => nameRef.current?.focus(), 50); }
  }
  useEffect(() => {
    if (typeof selId !== 'number') return;
    let live = true;
    api.filter(selId).then(r => {
      if (!live) return;
      setName(r.head.name); setGeneral(r.head.general); setWeb(r.head.web); setC(r.criteria);
      setBase(snapshot(r.head.name, r.head.general, r.head.web, r.criteria));
    }).catch(e => live && setMsg({ ok: false, t: (e as Error).message }));
    return () => { live = false; };
  }, [selId]);   // eslint-disable-line react-hooks/exhaustive-deps
  const reset = () => { try { const b = JSON.parse(base) as { n: string; g: boolean; w: boolean; cc: FilterCriteria }; setName(b.n); setGeneral(b.g); setWeb(b.w); setC(b.cc); } catch { /* nothing saved yet */ } };

  const body = () => ({ name: name.trim(), general, web: web && general, criteria: c, lang });
  // Live match count (debounced): how many documents the criteria select right now.
  useEffect(() => {
    if (selId === null || !o) return;
    let live = true; setCounting(true);
    const t = setTimeout(() => api.verifyFilter(body()).then(r => live && setCount(r.count)).catch(() => live && setCount(null)).finally(() => live && setCounting(false)), 550);
    return () => { live = false; clearTimeout(t); };
  }, [JSON.stringify(c), selId, !!o, lang]);   // eslint-disable-line react-hooks/exhaustive-deps

  async function run(fn: () => Promise<void>) { setBusy(true); setMsg(null); try { await fn(); } catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); } }
  const save = () => run(async () => {
    if (!name.trim()) { nameRef.current?.focus(); throw new Error(tr('Please give the filter a name.')); }
    const r = selId === 'new' ? await api.createFilter(body()) : await api.updateFilter(selId as number, body());
    await qc.invalidateQueries({ queryKey: ['filters'] }); await qc.invalidateQueries({ queryKey: ['docs'] });
    setBase(snapshot()); setSelId(r.idFilter); setMsg({ ok: true, t: tr('Filter “{0}” saved.', name.trim()) });
  });
  const remove = () => run(async () => {
    if (typeof selId !== 'number') return;
    await api.deleteFilter(selId); setAskDel(false);
    await qc.invalidateQueries({ queryKey: ['filters'] }); setBase(''); setSelId(null); setMsg({ ok: true, t: tr('Filter deleted.') });
  });
  const duplicate = () => { const n = name; setSelId('new'); setName(`${n} (copy)`); setGeneral(false); setWeb(false); setBase(''); setTimeout(() => nameRef.current?.select(), 50); setMsg({ ok: true, t: tr('Copy created: give it a name and save.') }); };
  useSaveShortcut(() => { if (!busy && editable && dirty) void save(); }, selId !== null);

  const idsOf = (a: IdName[] | undefined, re: RegExp) => (a ?? []).filter(x => re.test(x.name)).map(x => x.id);
  const PRESETS: { ico: string; title: string; sub: string; name: string; make: () => FilterCriteria }[] = [
    { ico: '⏳', title: tr('Expired documents'), sub: tr('Everything past its expiry date'), name: tr('Expired documents'), make: () => ({ statuses: idsOf(o?.statuses, /expired/i), ...(idsOf(o?.statuses, /expired/i).length ? {} : { expired: { active: true, from: '2000-01-01', to: today() } }) }) },
    { ico: '🕵️', title: tr('Waiting for verification'), sub: tr('Drafts and documents in edit'), name: tr('To verify'), make: () => ({ statuses: idsOf(o?.statuses, /^(draft|edit)/i) }) },
    { ico: '🚀', title: tr('Recently published'), sub: tr('Published in the last 30 days'), name: tr('Published last 30 days'), make: () => ({ statuses: idsOf(o?.statuses, /publish/i), published: { active: true, ...RANGES[2]!.make() } }) },
    { ico: '📝', title: tr('Edited this month'), sub: tr('Changed since the 1st'), name: tr('Edited this month'), make: () => ({ edited: { active: true, ...RANGES[3]!.make() } }) },
  ];

  const shown = useMemo(() => (list.data ?? []).filter(f =>
    (!q.trim() || f.name.toLowerCase().includes(q.trim().toLowerCase())) && (seg === 'all' || (seg === 'mine' ? f.mine : seg === 'general' ? f.general : f.web))), [list.data, q, seg]);
  const n = (p: (f: FilterHead) => boolean) => list.data?.filter(p).length ?? 0;
  const noCriteria = chips.length === 0;

  return (
    <div className="um">
      <PageHero icon={<IconFilter />} title={tr('Filter management')} sub={tr('Build saved filters for the document list: pick criteria, watch the match count, save')} chips={[{ n: list.data?.length ?? '–', label: 'filters' }, { n: n(f => f.general), label: 'general' }, { n: n(f => f.web), label: 'web' }]} />
      <div className="fx">
        <aside className="card fx-list">
          <button className="fx-new" onClick={() => open('new')}><span>＋</span> {tr('New filter')}</button>
          <div className="fx-search"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg><input value={q} onChange={e => setQ(e.target.value)} placeholder={tr('Search filters')} aria-label={tr('Search filters')} /></div>
          <div className="fx-seg" role="tablist">
            {([['all', tr('All'), list.data?.length ?? 0], ['mine', tr('Mine'), n(f => f.mine)], ['general', tr('General'), n(f => f.general)], ['web', tr('Web'), n(f => f.web)]] as ['all' | 'mine' | 'general' | 'web', string, number][]).map(([k, l, c2]) =>
              <button key={k} role="tab" aria-selected={seg === k} className={seg === k ? 'on' : ''} onClick={() => setSeg(k)}>{l}<em>{c2}</em></button>)}
          </div>
          <div className="fx-items">
            {list.isLoading && <PageLoader compact label={tr('Loading filters')} />}
            {shown.map(f => (
              <button key={f.idFilter} className={`fx-item ${selId === f.idFilter ? 'sel' : ''}`} onClick={() => open(f.idFilter)}>
                <span className={`ico ${f.general ? 'g' : 'm'}`}><IconFilter /></span>
                <span className="tx"><b>{f.name}</b><small>{f.mine ? tr('Yours') : tr('Shared')}{f.general ? tr(' · General') : ''}{f.web ? tr(' · Web') : ''}</small></span>
                {!f.mine && !f.general && <i title={tr('Read only')}>🔒</i>}
              </button>
            ))}
            {!list.isLoading && shown.length === 0 && <div className="fx-empty">{list.data?.length ? tr('No filter matches.') : tr('No filters yet. Create the first one!')}</div>}
          </div>
        </aside>

        <section className="card fx-edit">
          {selId === null ? (
            <div className="fx-hero">
              <div className="big">🎯</div><h3>{tr('Pick a filter, or build a new one')}</h3>
              <p>{tr('Filters narrow the document list to exactly what you need. Combine status, type, people and dates, and see how many documents match while you work.')}</p>
              <button className="btn-primary" onClick={() => open('new')}>{tr('＋ New filter')}</button>
            </div>
          ) : (<>
            <div className="fx-head">
              <div className="fx-namebox">
                <input ref={nameRef} value={name} maxLength={100} onChange={e => setName(e.target.value)} disabled={!editable} placeholder={tr('Name your filter…')} aria-label={tr('Filter name')} />
                <div className={`fx-count ${counting ? 'busy' : ''}`} title={tr('Documents matching these criteria in the current language')}>
                  {counting ? <Spinner /> : <b>{count ?? '–'}</b>}<span>{tr('match')}{count === 1 ? 'es' : ''} · {lang}</span>
                </div>
              </div>
              <div className="fx-switches">
                <Switch checked={general} disabled={!editable} onChange={v => { setGeneral(v); if (!v) setWeb(false); }} label={tr('General filter')} desc={tr('Visible to all users')} />
                <Switch checked={web && general} disabled={!editable || !general} onChange={setWeb} label={tr('Web publishing')} desc={general ? tr('Also offered on the website') : tr('Needs “General filter”')} />
              </div>
              {!editable && <div className="fx-ro">{tr('🔒 This filter belongs to another user. You can look at it, but not change it.')}</div>}
            </div>

            {selId === 'new' && noCriteria && o && (
              <div className="fx-start"><h6>{tr('Quick start')}</h6>
                <div className="fx-presets">{PRESETS.map(p => (
                  <button key={p.title} onClick={() => { setC(p.make()); if (!name.trim()) setName(p.name); }}><span>{p.ico}</span><b>{p.title}</b><small>{p.sub}</small></button>))}</div>
              </div>)}

            <div className="fx-chips" aria-label={tr('Active criteria')}>
              {noCriteria ? <span className="fx-hint">{tr('No criteria yet: this filter shows all documents.')}</span> : <>
                {chips.map(x => <span key={x.key} className="fx-chip" onClick={() => setTab(x.tab)}>{x.text}<button aria-label={tr('Remove {0}', x.text)} disabled={!editable} onClick={e => { e.stopPropagation(); x.clear(); }}>×</button></span>)}
                {editable && <button className="fx-clear" onClick={() => setC({})}>{tr('Clear all')}</button>}</>}
            </div>

            {opts.isLoading || !o ? <PageLoader compact label={tr('Loading options')} /> : (<>
              <div className="fx-tabs" role="tablist">
                {(['doc', 'control', 'other', 'date'] as Tab[]).map(k => (
                  <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
                    <span>{TAB_ICO[k]}</span>{TAB_LBL[k]}{tabCount(k) > 0 && <em>{tabCount(k)}</em>}</button>))}
              </div>
              <div className={`fx-pane ${editable ? '' : 'ro'}`}>
                {tab === 'doc' && (<>
                  <div className="fx-grid2">
                    <div className="fx-field"><div className="fx-lbl">{tr('Document name')}</div><input className="fx-in" value={c.docName ?? ''} placeholder={tr('Part of the name')} onChange={e => set('docName', e.target.value)} /></div>
                    <div className="fx-field"><div className="fx-lbl">{tr('Document ID')}</div><input className="fx-in" value={c.docId ?? ''} placeholder={tr('e.g. 121 or 121;130')} onChange={e => set('docId', e.target.value)} /></div>
                  </div>
                  <Pills label={tr('Status')} options={o.statuses} value={c.statuses ?? []} onChange={v => set('statuses', v)} />
                  <Pills label={tr('Document type')} options={o.types} value={c.types ?? []} onChange={v => set('types', v)} />
                  <div className="fx-grid2">
                    <div className="fx-field"><div className="fx-lbl">{tr('Search text')}</div><input className="fx-in" value={c.searchText ?? ''} placeholder={tr('Words in the document name')} onChange={e => set('searchText', e.target.value)} /></div>
                    <Combo label={tr('Special filter')} options={o.specials} value={c.special} onChange={v => set('special', v)} />
                  </div>
                </>)}
                {tab === 'control' && (
                  <div className="fx-grid2">
                    <Combo label={tr('Author')} options={o.accounts} value={c.author} onChange={v => set('author', v)} />
                    <Combo label={tr('Editor')} options={o.accounts} value={c.editor} onChange={v => set('editor', v)} />
                    <Combo label={tr('Verifier')} options={o.accounts} value={c.verifier} onChange={v => set('verifier', v)} />
                    <Combo label={tr('Releaser')} options={o.accounts} value={c.releaser} onChange={v => set('releaser', v)} />
                    <Combo label={tr('Publisher')} options={o.accounts} value={c.publisher} onChange={v => set('publisher', v)} />
                    <Combo label={tr('Distributor (mailing list)')} options={o.mailLists} value={c.distributor} onChange={v => set('distributor', v)} />
                    <Combo label={tr('Process owner')} options={o.owners} value={c.processOwner} onChange={v => set('processOwner', v)} />
                  </div>)}
                {tab === 'other' && (<>
                  <div className="fx-grid2">
                    <div className="fx-field"><div className="fx-lbl">{tr('Application (file type)')}</div>
                      <select className="fx-in" value={c.application ?? ''} onChange={e => set('application', e.target.value || undefined)}><option value="">{tr('Any')}</option>{o.extensions.map(x => <option key={x} value={x}>{x}</option>)}</select></div>
                    <div className="fx-field"><div className="fx-lbl">{tr('Language')}</div>
                      <select className="fx-in" value={c.language ?? ''} onChange={e => set('language', e.target.value || undefined)}><option value="">{tr('Any')}</option>{o.languages.map(x => <option key={x.id} value={x.id}>{x.id} – {x.name}</option>)}</select></div>
                    <Combo label={tr('Group (folder)')} options={o.groups} value={c.group} onChange={v => set('group', v)} />
                    <div className="fx-field"><div className="fx-lbl">{tr('Group number')}</div><input className="fx-in" value={c.groupNumber ?? ''} placeholder={tr('e.g. G45')} onChange={e => set('groupNumber', e.target.value)} /></div>
                  </div>
                  <div className="fx-switches col">
                    <Switch checked={!!c.includeSubgroups} disabled={!c.group || !!c.unlinked} onChange={v => set('includeSubgroups', v)} label={tr('Include subgroups')} desc={tr('Also documents in the folders below the chosen group')} />
                    <Switch checked={!!c.unlinked} disabled={!c.group} onChange={v => set('unlinked', v)} label={tr('Unlinked documents')} desc={tr('Documents that are NOT in the chosen group')} />
                  </div>
                </>)}
                {tab === 'date' && (<>
                  <p className="fx-hint">{tr('Switch a date range on to use it. All active ranges work together with the other criteria.')}</p>
                  {DATES.map(d => {
                    const r = range(d.key);
                    return (
                      <div key={d.key} className={`fx-date ${r.active ? 'on' : ''}`}>
                        <Switch checked={r.active} disabled={!editable} onChange={v => set(d.key, { ...r, active: v })} label={<>{d.ico} {d.label}</>} />
                        <div className="rng">
                          <label>{tr('From')}<input type="date" value={r.from} disabled={!r.active} max={r.to} onChange={e => set(d.key, { ...r, from: e.target.value })} /></label>
                          <label>{tr('To')}<input type="date" value={r.to} disabled={!r.active} min={r.from} onChange={e => set(d.key, { ...r, to: e.target.value })} /></label>
                        </div>
                        <div className="quick">{RANGES.map(p => <button key={p.label} type="button" disabled={!editable} onClick={() => set(d.key, { active: true, ...p.make() })}>{p.label}</button>)}</div>
                      </div>);
                  })}
                </>)}
              </div>
            </>)}

            <SaveBar dirty={dirty} busy={busy} canSave={editable && !!name.trim()} onSave={() => void save()} onReset={reset}>
              {typeof selId === 'number' && <>
                <button className="btn-ghost" onClick={() => nav(`/documents?filter=${selId}`)}>{tr('Show documents')}</button>
                <button className="btn-ghost" onClick={duplicate}>{tr('Duplicate')}</button>
                <button className="btn-ghost danger" onClick={() => setAskDel(true)} disabled={busy || !editable}>{tr('Delete')}</button></>}
            </SaveBar>
          </>)}
        </section>
      </div>
      {askDel && <ConfirmDialog danger title={tr('Delete filter?')} confirmLabel={tr('Delete')} busy={busy}
        message={<>{tr('The filter')}{' '}<b>{name}</b> {tr('will be removed for')}{' '}{general ? 'all users' : 'you'}{tr('. This cannot be undone.')}</>}
        onConfirm={remove} onCancel={() => setAskDel(false)} />}
      {pending !== undefined && <ConfirmDialog title={tr('Discard your changes?')} confirmLabel={tr('Discard')} busy={false}
        message={<>{tr('You changed')}{' '}<b>{name || 'this filter'}</b> {tr('and did not save it. If you continue, the changes are lost.')}</>}
        onConfirm={() => go(pending)} onCancel={() => setPending(undefined)} />}
      <Toast msg={msg} onClose={() => setMsg(null)} />
    </div>
  );
}
