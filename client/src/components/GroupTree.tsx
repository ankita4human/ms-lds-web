import { useEffect, useMemo, useState } from 'react';
import type { GroupNode } from '../api';
import ContextMenu, { type MenuItem } from './ContextMenu';
import { downloadCsv } from '../printing';

export type NodeSel = 'none' | 'all' | 'expired' | number;
export type TreeItem = GroupNode & { children: TreeItem[]; total: number };

/** Virtual folder that holds every group with GroupType = 1 (standards); it is not a real group and cannot be selected. */
export const STANDARD_ID = -5;
const STANDARD_TYPE = 1;

function build(groups: GroupNode[]): TreeItem[] {
  const byId = new Map<number, TreeItem>(groups.map(g => [g.idGroup, { ...g, children: [], total: g.docCount }]));
  const roots: TreeItem[] = [];
  const std: TreeItem = { idGroup: STANDARD_ID, idParent: 0, name: 'Standard', sort: 1e9, docCount: 0, accessible: true, children: [], total: 0 };
  for (const n of byId.values()) {
    const parent = n.idParent ? byId.get(n.idParent) : undefined;
    // Standard groups (GroupType 1) hang under the "Standard" folder; their own sub-groups keep their hierarchy.
    if (n.groupType === STANDARD_TYPE && parent?.groupType !== STANDARD_TYPE) std.children.push(n);
    else (parent ? parent.children : roots).push(n);
  }
  if (std.children.length > 0) roots.push(std);
  // Roll document counts up so a folder shows everything below it.
  const sum = (n: TreeItem): number => (n.total = n.docCount + n.children.reduce((a, c) => a + sum(c), 0));
  roots.forEach(sum);
  return roots;
}

const PALETTE = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899'];
const colorOf = (node: { idGroup: number }, depth: number) => (node.idGroup === STANDARD_ID ? '#b7791f' : PALETTE[depth % PALETTE.length]!);

const Chevron = ({ open }: { open: boolean }) => <svg className={`chev ${open ? 'op' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>;

/** Folder filter: a node stays when its name matches or one of its sub-groups does. */
function filterTree(nodes: TreeItem[], q: string): TreeItem[] {
  const out: TreeItem[] = [];
  for (const n of nodes) {
    const kids = filterTree(n.children, q);
    if (n.name.toLowerCase().includes(q) || kids.length > 0) out.push({ ...n, children: n.name.toLowerCase().includes(q) && kids.length === 0 ? n.children : kids });
  }
  return out;
}

function Row({ node, depth, sel, onSel, open, toggle, onMenu, busy, force, q }: {
  node: TreeItem; depth: number; sel: NodeSel; onSel: (s: NodeSel) => void; open: Set<number>; toggle: (id: number) => void;
  onMenu: (e: React.MouseEvent, n: TreeItem) => void; busy?: boolean; force?: boolean; q?: string;
}) {
  const isOpen = force || open.has(node.idGroup);
  const color = colorOf(node, depth);
  const hit = !!q && node.name.toLowerCase().includes(q);
  const has = node.children.length > 0;
  return (
    <>
      <div className={`tree-row ${sel === node.idGroup ? 'sel' : ''} ${node.accessible ? '' : 'dim'} ${hit ? 'hit' : ''}`} style={{ ['--c' as string]: color }}
        onClick={() => { if (node.idGroup === STANDARD_ID) toggle(node.idGroup); else { onSel(node.idGroup); if (has && !isOpen) toggle(node.idGroup); } }} onDoubleClick={() => has && toggle(node.idGroup)} title={node.name}
        onContextMenu={e => onMenu(e, node)}>
        <span className="tw" onClick={e => { e.stopPropagation(); if (has) toggle(node.idGroup); }}>{has ? <Chevron open={isOpen} /> : <i className="dotl" />}</span>
        <span className="gi-emoji">{node.idGroup === STANDARD_ID ? '🏛️' : isOpen && has ? '📂' : '📁'}</span>
        <span className="nm">{node.name}</span>
        {node.doNotPublish && <span className="gflag" title="Not shown on the web">🚫</span>}
        {node.pubOriginal && <span className="gflag" title="Published as original">📎</span>}
        {busy && node.idGroup !== STANDARD_ID && <span className="ct ld" aria-label="Counting documents">…</span>}
        {!busy && node.docCount > 0 && node.idGroup !== STANDARD_ID && <span className="ct" title={`${node.docCount} document(s) in this folder, ${node.total} including sub-groups`}>{node.docCount}</span>}
      </div>
      {isOpen && has && <div className="tree-kids" style={{ ['--c' as string]: color }}>{node.children.map(c => <Row key={c.idGroup} node={c} depth={depth + 1} sel={sel} onSel={onSel} open={open} toggle={toggle} onMenu={onMenu} busy={busy} force={force} q={q} />)}</div>}
    </>
  );
}

/** Keys of the right-click menus (manual p. 12-14). "printTree" is handled inside the tree, the rest by the page. */
export type GroupMenuKey = 'view' | 'rename' | 'new' | 'delete' | 'weblink' | 'report' | 'order' | 'web' | 'template' | 'pubOriginal' | 'owner';

export default function GroupTreeView({ groups, total, expired, sel, onSel, rootLabel, countsLoading, reveal, isAdmin, canCreateRoot, templateGroup, onAction }: {
  groups: GroupNode[]; total: number; expired: number; sel: NodeSel; onSel: (s: NodeSel, includeSub?: boolean) => void; rootLabel: string; countsLoading?: boolean; reveal?: { key: number; ids: number[] };
  isAdmin?: boolean; canCreateRoot?: boolean; templateGroup?: number; onAction?: (key: GroupMenuKey, node: GroupNode | null) => void;
}) {
  const allRoots = useMemo(() => build(groups), [groups]);
  const [fq, setFq] = useState('');
  const q = fq.trim().toLowerCase();
  const roots = useMemo(() => (q ? filterTree(allRoots, q) : allRoots), [allRoots, q]);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (id: number) => setOpen(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  // Expand the folders leading to a located document and scroll the selected folder into view.
  useEffect(() => {
    if (!reveal) return;
    const inStd = reveal.ids.some(i => groups.find(g => g.idGroup === i)?.groupType === STANDARD_TYPE);
    setOpen(prev => new Set([...prev, ...reveal.ids, ...(inStd ? [STANDARD_ID] : [])]));
    const t = setTimeout(() => document.querySelector('.tree-row.sel')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 150);
    return () => clearTimeout(t);
  }, [reveal?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const expandAll = () => setOpen(new Set([STANDARD_ID, ...groups.map(g => g.idGroup)]));

  // ---- right-click menus: root, process groups and standards have different entries ----
  const [ctx, setCtx] = useState<{ x: number; y: number; node: TreeItem | null } | null>(null);
  const openMenu = (e: React.MouseEvent, node: TreeItem | null) => {
    e.preventDefault(); e.stopPropagation();
    if (node?.idGroup === STANDARD_ID) { setCtx(null); return; }      // the virtual "Standard" folder has no menu
    if (node) onSel(node.idGroup);
    setCtx({ x: e.clientX, y: e.clientY, node });
  };
  const items = (node: TreeItem | null): MenuItem[] => {
    if (!node) return [
      { key: 'view', label: 'View all documents', icon: '📚', enabled: true },
      { key: 'printTree', label: 'Print Tree view (Excel / CSV)', icon: '🖨️', enabled: true },
      { key: 'new', label: 'New Group', icon: '➕', enabled: !!canCreateRoot, sepBefore: true },
      { key: 'weblink', label: 'Copy Weblink', icon: '🔗', enabled: true },
      { key: 'order', label: 'Change Order', icon: '↕️', enabled: true },
    ];
    const std = node.groupType === STANDARD_TYPE, can = node.accessible;
    const tick = (on: boolean | undefined, t: string) => (on ? `✓ ${t}` : t);
    return std ? [
      { key: 'view', label: 'View all documents', icon: '📚', enabled: true },
      { key: 'weblink', label: 'Copy Weblink', icon: '🔗', enabled: true, sepBefore: true },
      { key: 'report', label: 'Print Report', icon: '🖨️', enabled: true },
      { key: 'order', label: 'Change Order', icon: '↕️', enabled: can },
      { key: 'web', label: tick(node.doNotPublish, 'Do not view group in the web'), icon: '🚫', enabled: can, sepBefore: true },
      { key: 'pubOriginal', label: tick(node.pubOriginal, 'Publish as original'), icon: '📎', enabled: !!isAdmin && can },
    ] : [
      { key: 'view', label: 'View all documents', icon: '📚', enabled: true },
      { key: 'rename', label: 'Rename          F2', icon: '✏️', enabled: can, sepBefore: true },
      { key: 'new', label: 'New Group', icon: '➕', enabled: can },
      { key: 'delete', label: 'Delete', icon: '🗑️', enabled: can },
      { key: 'weblink', label: 'Copy Weblink', icon: '🔗', enabled: true, sepBefore: true },
      { key: 'report', label: 'Print Report', icon: '🖨️', enabled: true },
      { key: 'order', label: 'Change Order', icon: '↕️', enabled: can },
      { key: 'web', label: tick(node.doNotPublish, 'Do not view group in the web'), icon: '🚫', enabled: can, sepBefore: true },
      { key: 'template', label: tick(templateGroup === node.idGroup, 'Set as Template'), icon: '📐', enabled: !!isAdmin && can },
      { key: 'pubOriginal', label: tick(node.pubOriginal, 'Publish as original'), icon: '📎', enabled: !!isAdmin && can },
      { key: 'owner', label: 'Assign Process Owner', icon: '👤', enabled: can },
    ];
  };
  /** "Print Tree view": the groups that are visible right now (expanded folders only) as an Excel-readable CSV. */
  function exportTree() {
    const rows: (string | number)[][] = [['Level', 'Group', 'ID', 'Documents']];
    const walk = (n: TreeItem, d: number) => {
      rows.push([d + 1, `${'    '.repeat(d)}${n.name}`, n.idGroup === STANDARD_ID ? '' : n.idGroup, n.idGroup === STANDARD_ID ? '' : n.total]);
      if (open.has(n.idGroup)) n.children.forEach(c => walk(c, d + 1));
    };
    roots.forEach(r => walk(r, 0));
    downloadCsv('group-tree.csv', rows);
  }
  const pick = (key: string) => {
    const node = ctx?.node ?? null;
    if (key === 'printTree') exportTree();
    else if (key === 'view') onSel(node ? node.idGroup : 'all', true);
    else onAction?.(key as GroupMenuKey, node);
  };
  // F2 renames the selected group (same shortcut as the Windows client)
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'F2' || typeof sel !== 'number' || sel <= 0) return;
    const g = groups.find(x => x.idGroup === sel);
    if (g && g.accessible && g.groupType !== STANDARD_TYPE) { e.preventDefault(); onAction?.('rename', g); }
  };
  return (
    <div className="card tree-card" tabIndex={0} onKeyDown={onKey} style={{ outline: 'none' }} onContextMenu={e => { if (e.target === e.currentTarget) openMenu(e, null); }}>
      <div className="tree-title" onContextMenu={e => openMenu(e, null)} title="Right-click for the root menu">
        <span className="tt-l"><span className="tt-ico" aria-hidden="true">🗂️</span><span>{rootLabel}</span></span>
        <span className="tt-btns">
          <button className="tt-btn" onClick={expandAll} title="Expand all folders" aria-label="Expand all folders"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M7 8l5-5 5 5M7 16l5 5 5-5" /></svg></button>
          <button className="tt-btn" onClick={() => setOpen(new Set())} title="Collapse all folders" aria-label="Collapse all folders"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M7 4l5 5 5-5M7 20l5-5 5 5" /></svg></button>
        </span>
      </div>
      <div className="tree-search"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
        <input value={fq} onChange={e => setFq(e.target.value)} placeholder="Find a folder…" aria-label="Find a folder" />{fq && <button onClick={() => setFq('')} aria-label="Clear">×</button>}</div>
      <div className={`tree-row top all ${sel === 'all' ? 'sel' : ''}`} onClick={() => onSel('all')} onContextMenu={e => openMenu(e, null)}>
        <span className="tw" /><span className="gi-emoji">🗂️</span><span className="nm">All documents</span><span className={`ct ${countsLoading ? 'ld' : ''}`}>{countsLoading ? '…' : total}</span>
      </div>
      {roots.map(r => <Row key={r.idGroup} node={r} depth={0} sel={sel} onSel={onSel} open={open} toggle={toggle} onMenu={openMenu} busy={countsLoading} force={!!q} q={q} />)}
      {q && roots.length === 0 && <div className="mh" style={{ padding: '10px 14px' }}>No folder matches “{fq}”.</div>}
      <div className="sep" style={{ height: 1, background: 'var(--line)', margin: '8px 4px' }} />
      <div className={`tree-row top exp ${sel === 'expired' ? 'sel' : ''}`} onClick={() => onSel('expired')}>
        <span className="tw" /><span className="gi-emoji">⛔</span><span className="nm">Expired documents</span><span className={`ct ${countsLoading ? 'ld' : ''}`}>{countsLoading ? '…' : expired}</span>
      </div>
      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={items(ctx.node)} onPick={pick} onClose={() => setCtx(null)} />}
    </div>
  );
}
