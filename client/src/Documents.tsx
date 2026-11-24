import { useEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api, type DocRow, type GroupNode } from './api';
import { useLang } from './LangContext';
import { useGroupTree } from './useGroupTree';
import GroupTreeView, { type NodeSel, type GroupMenuKey } from './components/GroupTree';
import GroupAdmin, { type GroupAction } from './components/GroupAdmin';
import { allFilterDocs, downloadCsv, filterCsvRows, printFilterReport, printGroupReport, safeFile } from './printing';
import ContextMenu, { type MenuItem } from './components/ContextMenu';
import DocDetail from './components/DocDetail';
import { ExtBadge, StatusBadge, fmtDate, version } from './components/bits';
import { IconSearch } from './components/Icons';
import { PageLoader, SkeletonRows } from './components/Loader';
import UploadDialog from './components/UploadDialog';
import ChangeVersionDialog from './components/ChangeVersionDialog';
import EditDialog from './components/EditDialog';
import WorkflowDialog, { type FlowKind } from './components/WorkflowDialog';
import BulkFlowDialog, { planFor, type BulkKind } from './components/BulkFlowDialog';
import { CopyDialog, AssignDialog, RenameDialog, DeleteDialog } from './components/DocDialogs';
import { FreezeDialog, DefreezeDialog, ExpiryDialog, StandardLinkDialog, DependentsDialog } from './components/StatusDialogs';
import WorkflowRunDialog, { RemoveFromWorkflowDialog } from './components/WorkflowRunDialog';
import Toast, { type ToastMsg } from './components/Toast';

// Right-click menu from the MS LDS manual (Main Window - Right Click Menu).
// rights: 38 Edit, 34 New, 33 Delete, 18 Verify, 36 Release, 19 Publish, 40 Workflow, 35 Archive, 1 Admin.
const MENU: { key: string; label: string; icon: string; right?: number; sepBefore?: boolean; live?: boolean }[] = [
  { key: 'view', label: 'View', icon: '👁', live: true },
  { key: 'edit', label: 'Edit document', icon: '✏️', right: 38 },
  { key: 'checkout', label: 'Check out', icon: '⬇️', right: 38 },
  { key: 'checkin', label: 'Check in', icon: '⬆️', right: 38 },
  { key: 'new', label: 'New document', icon: '📄', right: 34, sepBefore: true },
  { key: 'copy', label: 'Copy', icon: '📋', right: 34 },
  { key: 'assign', label: 'Assignment', icon: '🗂️', right: 38 },
  { key: 'stdlink', label: 'Link to standard', icon: '⭐', right: 38 },
  { key: 'rename', label: 'Rename', icon: '🔤', right: 38 },
  { key: 'version', label: 'Change version', icon: '🔢', right: 38 },
  { key: 'delete', label: 'Delete', icon: '🗑️', right: 33 },
  { key: 'verify', label: 'Verify', icon: '✅', right: 18, sepBefore: true },
  { key: 'release', label: 'Release', icon: '🚀', right: 36 },
  { key: 'publish', label: 'Publish', icon: '📣', right: 19 },
  { key: 'relpub', label: 'Release / Publish', icon: '⚡', right: 19 },
  { key: 'workflow', label: 'Workflow', icon: '🔀', right: 40 },
  { key: 'wfremove', label: 'Remove from workflow', icon: '🚫', right: 40 },
  { key: 'preview', label: 'Web preview', icon: '🌐', live: false },
  { key: 'noweb', label: "Don't view in web", icon: '🙈', right: 38 },
  { key: 'block', label: 'Block', icon: '⛔', right: 38 },
  { key: 'expiry', label: 'Expiry / Do not expire', icon: '⏳', right: 37, sepBefore: true },
  { key: 'freeze', label: 'Frozen', icon: '❄️', right: 37 },
  { key: 'defreeze', label: 'Defrozen', icon: '🔥', right: 37 },
  { key: 'weblink', label: 'Copy weblink', icon: '🔗', live: true, sepBefore: true },
  { key: 'print', label: 'Print', icon: '🖨️', live: true },
];

export default function Documents() {
  const { lang, setLang, languages } = useLang();
  const nav = useNavigate();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [verDoc, setVerDoc] = useState<DocRow | null>(null);
  const [docAct, setDocAct] = useState<{ kind: 'copy' | 'assign' | 'rename' | 'delete' | 'stdlink' | 'expiry' | 'freeze' | 'defreeze' | 'workflow' | 'wfremove'; doc: DocRow } | null>(null);
  const [stdGate, setStdGate] = useState<{ doc: DocRow; then?: { kind: FlowKind; doc: DocRow } } | null>(null);   // link to mandatory standards first
  const [deps, setDeps] = useState<{ idDoc: number; docName: string } | null>(null);
  const stdOpt = useQuery({ queryKey: ['std-options'], queryFn: api.standardOptions, staleTime: 5 * 60_000 });
  const wfAfter = useRef<DocRow | null>(null);
  const wfCfg = useQuery({ queryKey: ['wf-config'], queryFn: api.wfConfig, staleTime: 5 * 60_000 });
  const frozenOpt = useQuery({ queryKey: ['frozen-options'], queryFn: api.frozenOptions, staleTime: 5 * 60_000 });
  const [editDoc, setEditDoc] = useState<DocRow | null>(null);
  const [flow, setFlow] = useState<{ kind: FlowKind; doc: DocRow } | null>(null);
  const [msg, setMsg] = useState<ToastMsg>(null);
  // multi-select (Ctrl/Shift+click or the check boxes) for bulk verify / release / publish
  const [checked, setChecked] = useState<Map<number, DocRow>>(new Map());
  const [bulk, setBulk] = useState<BulkKind | null>(null);
  const lastClick = useRef<number | null>(null);
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const loc = useLocation();
  const handled = useRef('');
  const locate = useRef<{ id: number; gid: number } | null>(null);  // document we are navigating to (deep link / chat)
  const [hiId, setHiId] = useState(0);
  const [reveal, setReveal] = useState<{ key: number; ids: number[] }>();
  const [sel, setSel] = useState<NodeSel>(params.get('q') || params.get('doc') || params.get('filter') ? 'all' : 'none');   // nothing is loaded until a folder is clicked
  const [subs, setSubs] = useState(false);   // true = also show the documents of the sub-groups (menu: View all documents)
  const [fid, setFid] = useState<number | null>(Number(params.get('filter')) || null);   // saved filter (Options > Filter management)
  const filters = useQuery({ queryKey: ['filters'], queryFn: api.filters });
  const [page, setPage] = useState(1); const [text, setText] = useState(params.get('q') ?? '');
  const [dText, setDText] = useState(text);
  useEffect(() => { const t = setTimeout(() => setDText(text), 350); return () => clearTimeout(t); }, [text]);   // wait for typing to pause
  const [sort, setSort] = useState('modified'); const [desc, setDesc] = useState(true);
  const [current, setCurrent] = useState<DocRow | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; doc: DocRow; bulk?: boolean } | null>(null);
  const [toast, setToast] = useState('');
  const pageSize = 25;

  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const tree = useGroupTree(lang);   // main groups first, lower levels and document counts stream in
  const list = useQuery({
    queryKey: ['docs', lang, sel, subs, fid, page, dText, sort, desc], enabled: !!lang && (sel !== 'none' || !!fid || !!dText), placeholderData: keepPreviousData,
    queryFn: () => api.documents({ page, pageSize, text: dText, sort, desc, lang,
      groupId: !fid && typeof sel === 'number' ? sel : undefined, direct: !subs, expired: !fid && sel === 'expired', filterId: fid ?? undefined }),
  });

  useEffect(() => { setPage(1); if (!locate.current) setCurrent(null); }, [lang, sel, subs, fid, dText]);
  useEffect(() => { setChecked(new Map()); }, [lang]);

  // Global search box in the top bar: /documents?q=...
  useEffect(() => { const q = params.get('q'); if (q !== null) { setText(q); setSel('all'); setFid(null); }
    const f = Number(params.get('filter')); if (f) setFid(f); }, [params]);

  // Deep link: /documents?group=12 shows that group (link made with "Copy Weblink" in the group menu).
  useEffect(() => {
    const g = Number(params.get('group')); if (!g || !tree.data) return;   // may wait for the level it sits in
    const byId = new Map(tree.data.groups.map(x => [x.idGroup, x]));
    if (!byId.has(g)) return;
    const ids: number[] = []; let cur = g, guard = 0;
    while (cur && byId.has(cur) && guard++ < 50) { ids.push(cur); cur = byId.get(cur)!.idParent; }
    setFid(null); setText(''); setSel(g); setReveal({ key: Date.now(), ids });
  }, [params, tree.data?.groups.length, tree.complete]); // eslint-disable-line react-hooks/exhaustive-deps

  // Deep link: /documents?doc=123 opens that document.
  const deepId = Number(params.get('doc')) || 0;
  const deep = useQuery({ queryKey: ['doc-deep', deepId, lang], enabled: deepId > 0 && !!lang,
    queryFn: () => api.document(deepId, lang) });
  // Jump to the document's folder: select it, expand its parents, then page to the row.
  useEffect(() => {
    const d = deep.data; if (!d || !tree.data || !tree.complete) return;   // needs every level to find the folder path
    const tag = `${loc.key}:${d.doc.idDoc}`;
    if (handled.current === tag) return;   // run once per navigation, not on every refetch
    handled.current = tag;
    setCurrent(d.doc);
    const gid = d.groupIds?.[0], groups = tree.data?.groups;
    if (gid && groups) {
      const byId = new Map(groups.map(g => [g.idGroup, g]));
      const ids: number[] = []; let cur = gid, guard = 0;
      while (cur && byId.has(cur) && guard++ < 50) { ids.push(cur); cur = byId.get(cur)!.idParent; }
      locate.current = { id: d.doc.idDoc, gid };
      setText(''); setPage(1); setFid(null); setSel(gid); setReveal({ key: Date.now(), ids });
    }
  }, [deep.data, tree.data, tree.complete, loc.key]); // eslint-disable-line react-hooks/exhaustive-deps
  // Find the row: move through pages until the located document is on screen, then scroll to it.
  useEffect(() => {
    const t = locate.current;
    // Wait until the list really shows the target folder (not the previous one) and has finished loading.
    if (!t || sel !== t.gid || !list.data || list.isPlaceholderData || list.isFetching) return;
    if (list.data.items.some(i => i.idDoc === t.id)) {
      locate.current = null; setHiId(t.id);
      setTimeout(() => document.getElementById(`doc-row-${t.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 150);
      setTimeout(() => setHiId(0), 4000);
    } else if (page < Math.ceil(list.data.total / pageSize)) setPage(p => p + 1);
    else locate.current = null;
  }, [list.data, list.isPlaceholderData, list.isFetching, page, sel, reveal]); // eslint-disable-line react-hooks/exhaustive-deps

  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / pageSize));
  const hasRight = (r?: number) => !r || !!me.data?.isAdmin || !!me.data?.rights.includes(r);
  // Verify: Draft/Edit documents; Release: Verified documents (legacy approveDocument / relDocument).
  const FROZEN_OFF = ['edit', 'checkout', 'checkin', 'version', 'verify', 'release', 'relpub', 'publish', 'workflow', 'block', 'rename', 'stdlink', 'expiry', 'freeze'];
  const stateOk = (key: string, d?: DocRow) => {
    if (!d) return true;
    if (key === 'wfremove') return !!d.isCycle;
    if (d.status === 11) return key === 'defreeze' || !FROZEN_OFF.includes(key);   // Frozen: no change except Defrozen (manual p. 163)
    if (key === 'defreeze') return false;
    if (key === 'freeze') return d.status === 3 || d.status === 6 || d.status === 8;
    return key === 'verify' ? d.status === 1 || d.status === 2 : key === 'release' || key === 'relpub' ? d.status === 7 : key === 'publish' ? d.status === 8 || d.status === 3 : true;
  };
  const stateMsg: Record<string, string> = { verify: 'Only documents in Draft or Edit status can be verified.', release: 'Only verified documents can be released. Verify the document first.',
    relpub: 'Only verified documents can be released and published. Verify the document first.', publish: 'Only released documents can be published. Release the document first.' };
  const items: MenuItem[] = MENU.filter(m => (frozenOpt.data?.enabled !== false || (m.key !== 'freeze' && m.key !== 'defreeze')) && (stdOpt.data?.enabled || m.key !== 'stdlink') && (wfCfg.data?.enabled !== false || (m.key !== 'workflow' && m.key !== 'wfremove'))).map(m => ({ key: m.key, label: m.label, icon: m.icon, sepBefore: m.sepBefore, enabled: (m.live === true || (m.live !== false && hasRight(m.right))) && stateOk(m.key, menu?.doc) }));

  // ---- bulk selection ----
  const toggleOne = (d: DocRow) => setChecked(c => { const n = new Map(c); if (n.has(d.idDoc)) n.delete(d.idDoc); else n.set(d.idDoc, d); return n; });
  const pageItems = list.data?.items ?? [];
  const allOnPage = pageItems.length > 0 && pageItems.every(d => checked.has(d.idDoc));
  const togglePage = () => setChecked(c => { const n = new Map(c); if (allOnPage) pageItems.forEach(d => n.delete(d.idDoc)); else pageItems.forEach(d => n.set(d.idDoc, d)); return n; });
  function rowClick(e: RMouseEvent, d: DocRow) {
    if (e.shiftKey && lastClick.current !== null) {
      const a = pageItems.findIndex(x => x.idDoc === lastClick.current), b = pageItems.findIndex(x => x.idDoc === d.idDoc);
      if (a >= 0 && b >= 0) { const [lo, hi] = a < b ? [a, b] : [b, a]; setChecked(c => { const n = new Map(c); pageItems.slice(lo, hi + 1).forEach(x => n.set(x.idDoc, x)); return n; }); window.getSelection()?.removeAllRanges(); return; }
    }
    if (e.ctrlKey || e.metaKey) { toggleOne(d); lastClick.current = d.idDoc; return; }
    lastClick.current = d.idDoc; setCurrent(d);
  }
  const picked = useMemo(() => [...checked.values()], [checked]);
  const eligible = (k: BulkKind) => picked.filter(d => typeof planFor(k, d, hasRight) !== 'string').length;
  const BULK: { key: BulkKind; label: string; icon: string }[] = [
    { key: 'verify', label: 'Verify', icon: '✅' }, { key: 'release', label: 'Release', icon: '🚀' },
    { key: 'publish', label: 'Publish', icon: '📣' }, { key: 'all', label: 'Verify → Release → Publish', icon: '⚡' }];
  const bulkItems: MenuItem[] = BULK.map((b, i) => ({ key: 'bulk-' + b.key, label: `${b.label} (${eligible(b.key)} of ${picked.length})`, icon: b.icon, sepBefore: i === 3, enabled: eligible(b.key) > 0 }));

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 2800); };

  // ---- right-click menus of the left panel (manual p. 12-15): groups, filters, distribution lists ----
  const [grpAct, setGrpAct] = useState<GroupAction | null>(null);
  const [fmenu, setFmenu] = useState<{ x: number; y: number; id: number; name: string } | null>(null);
  const [dmenu, setDmenu] = useState<{ x: number; y: number } | null>(null);
  const mailLists = useQuery({ queryKey: ['maillists'], queryFn: api.mailLists });
  async function afterGroupChange(text: string, ok = true, selectId?: number) {
    setGrpAct(null);
    setMsg({ ok, t: text });
    if (!ok) return;
    await Promise.all(['groups', 'docs', 'doc', 'doc-deep', 'stats'].map(x => qc.invalidateQueries({ queryKey: [x] })));
    if (selectId) { setFid(null); setSel(selectId); setReveal({ key: Date.now(), ids: [selectId] }); }
  }
  async function groupAction(key: GroupMenuKey, node: GroupNode | null) {
    const id = node?.idGroup ?? 0;
    const fail = (e: unknown) => setMsg({ ok: false, t: e instanceof Error ? e.message : 'The action failed.' });
    if (key === 'new' || key === 'rename' || key === 'delete' || key === 'owner' || key === 'order') { setGrpAct({ kind: key, node }); return; }
    if (key === 'weblink') {
      const link = node ? `${location.origin}/documents?group=${id}` : `${location.origin}/documents`;
      navigator.clipboard?.writeText(link).then(() => flash(node ? `Group link copied (G${id})` : 'Weblink copied'), () => flash(link));
      return;
    }
    try {
      if (key === 'report' && node) {
        const r = await api.groupReport(id, lang);
        if (!printGroupReport(r)) setMsg({ ok: false, t: 'The print window was blocked by the browser. Allow pop-ups for this site and try again.' });
      } else if (key === 'web' && node) {
        const r = await api.setGroupWeb(id, lang, !node.doNotPublish);
        await afterGroupChange(node.doNotPublish ? `“${node.name}” is shown on the web again.` : `“${node.name}” ${r.groups > 1 ? `and its ${r.groups - 1} sub-group(s) are` : 'is'} no longer shown on the web.`);
      } else if (key === 'pubOriginal' && node) {
        await api.setGroupPubOriginal(id, lang, !node.pubOriginal);
        await afterGroupChange(node.pubOriginal ? `“${node.name}” is published with HTML again.` : `Documents of “${node.name}” are published as the original file only.`);
      } else if (key === 'template' && node) {
        const on = tree.data?.templateGroup !== id;
        await api.setGroupTemplate(id, lang, on);
        await afterGroupChange(on ? `“${node.name}” is now the template folder.` : `“${node.name}” is no longer the template folder.`);
      }
    } catch (e) { fail(e); }
  }
  async function filterAction(key: string, f: { id: number; name: string }) {
    if (key === 'manage') { nav('/options/filters'); return; }
    try {
      const docs = await allFilterDocs(f.id, lang);
      if (key === 'print') { if (!printFilterReport(f.name, docs)) setMsg({ ok: false, t: 'The print window was blocked by the browser. Allow pop-ups for this site and try again.' }); }
      else downloadCsv(`${safeFile(f.name)}.csv`, filterCsvRows(docs));
    } catch (e) { setMsg({ ok: false, t: e instanceof Error ? e.message : 'The filter could not be loaded.' }); }
  }

  function pick(key: string, doc: DocRow) {
    if (key.startsWith('bulk-')) { setBulk(key.slice(5) as BulkKind); return; }
    if (key === 'view') setCurrent(doc);
    else if (key === 'new') setUploadOpen(true);
    else if (key === 'edit' || key === 'checkout' || key === 'checkin') setEditDoc(doc);
    else if (key === 'verify' || key === 'release' || key === 'publish' || key === 'relpub') {
      if (!stateOk(key, doc)) setMsg({ ok: false, t: stateMsg[key] });
      else if (key === 'release' || key === 'relpub') {
        // manual p. 64-66: the document has to be linked to every mandatory standard before it is released
        api.docStandards(doc.idDoc, lang).then(r => {
          if (r.items.some(i => !i.linked)) setStdGate({ doc, then: { kind: key, doc } }); else setFlow({ kind: key, doc });
        }, () => setFlow({ kind: key, doc }));
      }
      else setFlow({ kind: key, doc });
    }
    else if (key === 'version') {
      if (doc.status === 1) flash('The version cannot be changed while the document is in Draft status.');
      else setVerDoc(doc);
    }
    else if (key === 'weblink') {
      const link = `${location.origin}/documents?doc=${doc.idDoc}`;
      navigator.clipboard?.writeText(link).then(() => flash('Weblink copied'), () => flash(link));
    } else if (key === 'print') { setCurrent(doc); setTimeout(() => window.print(), 300); }
    else if (key === 'copy' || key === 'assign' || key === 'rename' || key === 'delete' || key === 'stdlink' || key === 'expiry' || key === 'freeze' || key === 'defreeze' || key === 'workflow' || key === 'wfremove') setDocAct({ kind: key, doc });
    else flash('This action is not available.');
  }
  const head = (label: string, key: string) => (
    <th onClick={() => { setDesc(sort === key ? !desc : false); setSort(key); }}>{label}{sort === key ? (desc ? ' ▾' : ' ▴') : ''}</th>);
  const nodeName = fid ? `Filter: ${filters.data?.find(f => f.idFilter === fid)?.name ?? fid}` : sel === 'none' ? 'Select a folder' : sel === 'all' ? 'All documents' : sel === 'expired' ? 'Expired documents'
    : tree.data?.groups.find(g => g.idGroup === sel)?.name ?? '';

  return (
    <div className="docs">
      <div className="docs-side">
        <GroupTreeView groups={tree.data?.groups ?? []} total={tree.data?.total ?? 0} expired={tree.data?.expired ?? 0}
          sel={fid ? -1 : sel} onSel={(s, all) => { setFid(null); setSubs(!!all); setSel(s); }} rootLabel={`${lang} Document structure`} countsLoading={tree.countsLoading} reveal={reveal}
          isAdmin={!!me.data?.isAdmin} canCreateRoot={!!tree.data?.canCreateRoot} templateGroup={tree.data?.templateGroup} onAction={groupAction} />
        <div className="card flt-card">
          <div className="tree-title"><span>Filters</span><a href="/options/filters" onClick={e => { e.preventDefault(); nav('/options/filters'); }} style={{ fontSize: 12 }}>Manage</a></div>
          {filters.isLoading && <PageLoader compact label="Loading filters" />}
          {filters.data?.map(f => (
            <div key={f.idFilter} className={`tree-row ${fid === f.idFilter ? 'sel' : ''}`} onClick={() => { setFid(f.idFilter); setText(''); }} title={f.name}
              onContextMenu={e => { e.preventDefault(); setFmenu({ x: e.clientX, y: e.clientY, id: f.idFilter, name: f.name }); }}>
              <span className="tw" /><span>🔎</span><span className="nm">{f.name}</span>
            </div>
          ))}
          {filters.data?.length === 0 && <div className="mh" style={{ padding: '4px 10px' }}>No filters yet.</div>}
        </div>
        <div className="card flt-card">
          <div className="tree-title" onContextMenu={e => { e.preventDefault(); setDmenu({ x: e.clientX, y: e.clientY }); }}><span>Distribution lists</span>
            <a href="/options/distribution" onClick={e => { e.preventDefault(); nav('/options/distribution'); }} style={{ fontSize: 12 }}>Manage</a></div>
          {mailLists.isLoading && <PageLoader compact label="Loading lists" />}
          {mailLists.data?.items.map(m => (
            <div key={m.id} className="tree-row" title={`${m.members} member(s)`} onClick={() => nav('/options/distribution')}
              onContextMenu={e => { e.preventDefault(); setDmenu({ x: e.clientX, y: e.clientY }); }}>
              <span className="tw" /><span>✉️</span><span className="nm">{m.name}</span><span className="ct">{m.members}</span>
            </div>
          ))}
          {mailLists.data?.items.length === 0 && <div className="mh" style={{ padding: '4px 10px' }}>No lists yet.</div>}
        </div>
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="toolbar">
          <div className="crumb">{nodeName}<small>{list.data?.total ?? 0} documents</small></div>
          <div className="search"><IconSearch /><input placeholder="Search by name or ID..." value={text} onChange={e => setText(e.target.value)} /></div>
          {!fid && typeof sel === 'number' && sel > 0 && <button className={`ord-chip ${sort === 'manual' ? 'on' : ''}`} title="Show the documents in the order chosen with Change Order"
            onClick={() => { setSort(sort === 'manual' ? 'modified' : 'manual'); setDesc(sort === 'manual'); }}>↕ Group order</button>}
          {hasRight(34) && <button className="btn-new" onClick={() => setUploadOpen(true)}>＋ New document</button>}
        </div>
        {list.isError && <div className="card error" role="alert">Could not load documents.</div>}
        {checked.size > 0 && (
          <div className="bk-bar" role="toolbar" aria-label="Actions for the selected documents">
            <span className="bk-count"><b>{checked.size}</b> selected</span>
            {BULK.map(b => <button key={b.key} className="bk-btn" disabled={eligible(b.key) === 0} onClick={() => setBulk(b.key)}
              title={eligible(b.key) === 0 ? 'None of the selected documents can take this step' : `${eligible(b.key)} of ${checked.size} can take this step`}>
              <span aria-hidden="true">{b.icon}</span> {b.label}<em>{eligible(b.key)}</em></button>)}
            <button className="bk-clear" onClick={() => setChecked(new Map())}>Clear selection</button>
          </div>
        )}
        <div className="card table-wrap" style={{ padding: 0 }}>
          {list.isFetching && !list.isLoading && <div className="fetch-veil"><PageLoader compact label="Loading documents" /></div>}
          <table className="grid-table">
            <thead><tr><th className="sel-col"><input type="checkbox" checked={allOnPage} onChange={togglePage} aria-label="Select all documents on this page" title="Select all on this page" /></th>{head('ID', 'id')}{head('Document', 'name')}{head('Status', 'status')}{head('Type', 'type')}<th>Version</th><th>App</th>
              <th>Std. lang</th>{head('Created', 'created')}{head('Creator', 'creator')}{head('Published', 'published')}<th>Publisher</th>{head('Released', 'released')}{head('Expires', 'expires')}</tr></thead>
            <tbody>
              {(list.isLoading || !lang) && <SkeletonRows rows={10} cols={14} />}
              {sel === 'none' && !fid && !dText && <tr><td colSpan={14} style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--muted)' }}>📁 Click a folder in the structure on the left to show its documents and sub-groups.<br /><small>Right-click a folder and choose “View all documents” to include its sub-groups.</small></td></tr>}
              {list.data?.items.map(d => (
                <tr key={d.idDoc} id={`doc-row-${d.idDoc}`} className={`${current?.idDoc === d.idDoc ? 'sel' : ''} ${checked.has(d.idDoc) ? 'chk' : ''} ${hiId === d.idDoc ? 'flash' : ''}`} onClick={e => rowClick(e, d)}
                  onContextMenu={e => { e.preventDefault(); if (checked.size > 1 && checked.has(d.idDoc)) { setMenu({ x: e.clientX, y: e.clientY, doc: d, bulk: true }); return; } setCurrent(d); setMenu({ x: e.clientX, y: e.clientY, doc: d }); }}>
                  <td className="sel-col" onClick={e => e.stopPropagation()}><input type="checkbox" checked={checked.has(d.idDoc)} onChange={() => { toggleOne(d); lastClick.current = d.idDoc; }} aria-label={`Select ${d.docName}`} /></td>
                  <td>{d.idDoc}</td><td title={d.docName}><b>{d.docName}</b></td><td><StatusBadge id={d.status} name={d.statusName} /></td>
                  <td>{d.typeName}</td><td>{version(d)}</td><td><ExtBadge ext={d.extension} /></td><td>{d.langStandard}</td>
                  <td>{fmtDate(d.dateCre)}</td><td>{d.creator}</td><td>{fmtDate(d.datePub)}</td><td>{d.publisher}</td>
                  <td>{fmtDate(d.dateRel)}</td><td>{fmtDate(d.dateExp)}</td>
                </tr>))}
              {list.data && !list.data.items.length && <tr><td colSpan={14} style={{ textAlign: 'center', padding: 28, color: 'var(--muted)' }}>No documents found.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="pager">
          <span>Page {page} of {pages}</span>
          <span><button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>{' '}
            <button disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button></span>
        </div>
        {current && <DocDetail key={`${current.idDoc}-${lang}`} doc={current} lang={lang} />}
      </div>
      {flow && <WorkflowDialog kind={flow.kind} doc={flow.doc} lang={lang} onClose={() => setFlow(null)}
        onRefresh={() => ['docs', 'doc', 'doc-deep', 'stats', 'groups'].forEach(x => qc.invalidateQueries({ queryKey: [x] }))} onDone={async r => {
        const name = flow.doc.docName; const k = flow.kind; setFlow(null);
        await Promise.all(['docs', 'doc', 'doc-deep', 'stats', 'groups'].map(x => qc.invalidateQueries({ queryKey: [x] })));
        setCurrent(c => c && c.idDoc === r.idDoc ? { ...c, status: r.status } : c);
        const rel = `was released as version ${r.version}${r.languages?.length ? `; ${r.languages.join(', ')} now in Edit status` : ''}`;
        const q = 'is in the publishing queue. The bell at the top shows the progress and tells you when it is published';
        const mailNote = (r.mailSent ? ' The release e-mail was sent.' : '') + (r.publishMail ? ' The publish e-mail is sent when publishing is finished.' : '')
          + (r.mailError ? ` The release e-mail could not be sent: ${r.mailError}` : '');
        setMsg({ ok: !r.mailError, t: (k === 'verify' ? `“${name}” was verified.` : k === 'release' ? `“${name}” ${rel}.`
          : k === 'publish' ? `“${name}” ${q}.` : `“${name}” ${rel}, and ${q}.`) + mailNote });
        window.dispatchEvent(new Event('pl-publish-queued'));
      }} />}
      <Toast msg={msg} onClose={() => setMsg(null)} />
      {grpAct && <GroupAdmin action={grpAct} lang={lang} onClose={() => setGrpAct(null)}
        onDone={(t, ok, id) => { if (grpAct.kind === 'order' && ok !== false) { setSort('manual'); setDesc(false); }
          afterGroupChange(t, ok, id); }} />}
      {fmenu && <ContextMenu x={fmenu.x} y={fmenu.y} onClose={() => setFmenu(null)} onPick={k => filterAction(k, fmenu)}
        items={[{ key: 'manage', label: 'Filter Management', icon: '🧰', enabled: true }, { key: 'print', label: 'Print Report', icon: '🖨️', enabled: true }, { key: 'csv', label: 'Export CSV', icon: '📤', enabled: true }]} />}
      {dmenu && <ContextMenu x={dmenu.x} y={dmenu.y} onClose={() => setDmenu(null)} onPick={() => nav('/options/distribution')}
        items={[{ key: 'mail', label: 'E-mail Distribution', icon: '✉️', enabled: true }]} />}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.bulk ? bulkItems : items} onPick={k => pick(k, menu.doc)} onClose={() => setMenu(null)} />}
      {bulk && <BulkFlowDialog kind={bulk} docs={picked} lang={lang} can={hasRight} onClose={() => setBulk(null)}
        onFinished={async r => {
          await Promise.all(['docs', 'doc', 'doc-deep', 'stats', 'groups'].map(x => qc.invalidateQueries({ queryKey: [x] })));
          if (r.queued) window.dispatchEvent(new Event('pl-publish-queued'));
          setChecked(new Map()); setCurrent(null);
        }} />}
      {uploadOpen && (
        <UploadDialog groups={tree.data?.groups ?? []} defaultGroup={typeof sel === 'number' ? sel : null} lang={lang} languages={languages} canWorkflow={!!wfCfg.data?.canUse}
          onClose={() => setUploadOpen(false)}
          onDone={(rs, chooseWf) => {
            setUploadOpen(false);
            const r = rs[0]; if (!r) return;
            const newDoc = { idDoc: r.idDoc, docName: r.name, lang: r.lang } as DocRow;
            if (chooseWf) wfAfter.current = newDoc;
            const openWf = () => { const w = wfAfter.current; wfAfter.current = null; if (w) setDocAct({ kind: 'workflow', doc: w }); };   // manual p. 117: choose the workflow when a document is created
            api.docStandards(r.idDoc, r.lang).then(x => { if (x.items.length > 0) setStdGate({ doc: newDoc }); else openWf(); }, openWf);   // manual p. 65: assign to the mandatory standards on creation
            setMsg({ ok: true, t: rs.length === 1 ? `Document ${r.idDoc} uploaded (${r.languages.join(', ')}).` : `${rs.length} documents were uploaded (IDs ${rs.map(x => x.idDoc).join(', ')}).` });
            if (r.lang !== lang) setLang(r.lang);          // show the new document in the language it was created for
            nav(`/documents?doc=${r.idDoc}`);                // jump to its folder and highlight it
          }} />
      )}
      {docAct?.kind === 'copy' && (
        <CopyDialog doc={docAct.doc} lang={lang} groups={tree.data?.groups ?? []} defaultGroup={typeof sel === 'number' ? sel : null} onClose={() => setDocAct(null)}
          onDone={(id, n) => { setDocAct(null); flash(`Copy created: #${id} ${n}`); nav(`/documents?doc=${id}`); }} />
      )}
      {docAct?.kind === 'stdlink' && <StandardLinkDialog doc={docAct.doc} lang={lang} onClose={() => setDocAct(null)} onDone={m => { setDocAct(null); flash(m); }} />}
      {docAct?.kind === 'expiry' && <ExpiryDialog doc={docAct.doc} lang={lang} onClose={() => setDocAct(null)} onDone={m => { setDocAct(null); flash(m); }} />}
      {docAct?.kind === 'freeze' && <FreezeDialog doc={docAct.doc} lang={lang} onClose={() => setDocAct(null)} onDone={m => { setDocAct(null); setMsg({ ok: true, t: m }); }} />}
      {docAct?.kind === 'defreeze' && <DefreezeDialog doc={docAct.doc} lang={lang} onClose={() => setDocAct(null)} onDone={m => { setDocAct(null); setMsg({ ok: true, t: m }); }} />}
      {docAct?.kind === 'workflow' && <WorkflowRunDialog doc={docAct.doc} lang={lang} onClose={() => setDocAct(null)} onDone={m => { setDocAct(null); setMsg({ ok: !/no mail was sent|could not be sent/i.test(m), t: m }); }} />}
      {docAct?.kind === 'wfremove' && <RemoveFromWorkflowDialog doc={docAct.doc} lang={lang} onClose={() => setDocAct(null)} onDone={(m, ok) => { setDocAct(null); setMsg({ ok, t: m }); }} />}
      {stdGate && <StandardLinkDialog doc={stdGate.doc} lang={lang} intro="This document is not yet linked to all mandatory standards. Link it before it is released."
        onClose={() => { setStdGate(null); const w = wfAfter.current; wfAfter.current = null; if (w) setDocAct({ kind: 'workflow', doc: w }); }} onDone={m => { const t = stdGate.then; setStdGate(null); flash(m); if (t) setFlow(t); else { const w = wfAfter.current; wfAfter.current = null; if (w) setDocAct({ kind: 'workflow', doc: w }); } }} />}
      {deps && <DependentsDialog doc={deps} lang={lang} onClose={() => setDeps(null)} onDone={m => { setDeps(null); flash(m); }} />}
      {docAct?.kind === 'assign' && (
        <AssignDialog doc={docAct.doc} lang={lang} groups={tree.data?.groups ?? []} onClose={() => setDocAct(null)} onChanged={flash} />
      )}
      {docAct?.kind === 'rename' && (
        <RenameDialog doc={docAct.doc} lang={lang} onClose={() => setDocAct(null)} onDone={m => { setDocAct(null); flash(m); }} />
      )}
      {docAct?.kind === 'delete' && (
        <DeleteDialog doc={docAct.doc} lang={lang} onClose={() => setDocAct(null)}
          onDone={(m, ok) => { setDocAct(null); if (ok) { setCurrent(null); flash(m); } else setMsg({ ok: false, t: m }); }} />
      )}
      {verDoc && (
        <ChangeVersionDialog doc={verDoc} lang={lang} onClose={() => setVerDoc(null)}
          onDone={r => { setVerDoc(null); flash(`Version ${r.version} saved (${r.languages.join(', ')})${r.republish ? ' – the document is published and was queued for publishing again (see the bell)' : ''}`); if (r.republish) window.dispatchEvent(new Event('pl-publish-queued')); nav(`/documents?doc=${r.idDoc}`); }} />
      )}
      {editDoc && (
        <EditDialog doc={editDoc} lang={lang} onClose={() => setEditDoc(null)}
          onDone={r => {
            const d = editDoc; setEditDoc(null); flash(`Checked in: version ${r.version}${r.archived ? ' (previous version archived)' : ''}`); nav(`/documents?doc=${r.idDoc}`);
            // manual p. 83-85, 167: the documents that depend on this one go to Edit mode (all of them, or the ones the user chooses)
            api.dependents(r.idDoc, lang).then(async dp => {
              const movable = dp.items.filter(i => i.movable); if (movable.length === 0) return;
              if (dp.choose) setDeps({ idDoc: r.idDoc, docName: d.docName });
              else { const x = await api.editDependents(r.idDoc, lang, movable.map(i => i.idDoc)); flash(`${x.moved} dependent document(s) put in Edit mode.`); await qc.invalidateQueries({ queryKey: ['docs'] }); }
            }, () => undefined);
            // the user has an open Edit task for this document: offer the workflow hand-over right away
            if (wfCfg.data?.canUse) api.wfTasks(lang, 1).then(t => { if (t.items.some(i => i.idDoc === r.idDoc)) setDocAct({ kind: 'workflow', doc: d }); }, () => undefined);
          }} />
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
