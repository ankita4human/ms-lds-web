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

function Row({ node, depth, sel, onSel, open, toggle, onMenu, busy }: {
  node: TreeItem; depth: number; sel: NodeSel; onSel: (s: NodeSel) => void; open: Set<number>; toggle: (id: number) => void;
  onMenu: (e: React.MouseEvent, n: TreeItem) => void; busy?: boolean;
}) {
  const isOpen = open.has(node.idGroup);
  const has = node.children.length > 0;
  return (
    <>
      <div className={`tree-row ${sel === node.idGroup ? 'sel' : ''} ${node.accessible ? '' : 'dim'}`} style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => { if (node.idGroup === STANDARD_ID) toggle(node.idGroup); else { onSel(node.idGroup); if (has && !isOpen) toggle(node.idGroup); } }} onDoubleClick={() => has && toggle(node.idGroup)} title={node.name}
        onContextMenu={e => onMenu(e, node)}>
        <span className="tw" onClick={e => { e.stopPropagation(); if (has) toggle(node.idGroup); }}>{has ? (isOpen ? '▾' : '▸') : ''}</span>
        <span>{node.idGroup === STANDARD_ID ? '🏛️' : isOpen && has ? '📂' : '📁'}</span>
        <span className="nm">{node.name}</span>
        {node.doNotPublish && <span className="gflag" title="Not shown on the web">🚫</span>}
        {node.pubOriginal && <span className="gflag" title="Published as original">📎</span>}
        {busy && node.idGroup !== STANDARD_ID && <span className="ct ld" aria-label="Counting documents">…</span>}
        {!busy && node.docCount > 0 && node.idGroup !== STANDARD_ID && <span className="ct" title={`${node.docCount} document(s) in this folder, ${node.total} including sub-groups`}>{node.docCount}</span>}
      </div>
      {isOpen && node.children.map(c => <Row key={c.idGroup} node={c} depth={depth + 1} sel={sel} onSel={onSel} open={open} toggle={toggle} onMenu={onMenu} busy={busy} />)}
    </>
  );
}

/** Keys of the right-click menus (manual p. 12-14). "printTree" is handled inside the tree, the rest by the page. */
export type GroupMenuKey = 'view' | 'rename' | 'new' | 'delete' | 'weblink' | 'report' | 'order' | 'web' | 'template' | 'pubOriginal' | 'owner';

export default function GroupTreeView({ groups, total, expired, sel, onSel, rootLabel, countsLoading, reveal, isAdmin, canCreateRoot, templateGroup, onAction }: {
  groups: GroupNode[]; total: number; expired: number; sel: NodeSel; onSel: (s: NodeSel, includeSub?: boolean) => void; rootLabel: string; countsLoading?: boolean; reveal?: { key: number; ids: number[] };
  isAdmin?: boolean; canCreateRoot?: boolean; templateGroup?: number; onAction?: (key: GroupMenuKey, node: GroupNode | null) => void;
}) {
  const roots = useMemo(() => build(groups), [groups]);
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
      <div className="tree-title" onContextMenu={e => openMenu(e, null)} title="Right-click for the root menu"><span>{rootLabel}</span>
        <span><button className="btn-ghost" style={{ padding: '2px 8px', fontSize: 12 }} onClick={expandAll}>Expand</button>{' '}
          <button className="btn-ghost" style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => setOpen(new Set())}>Collapse</button></span>
      </div>
      <div className={`tree-row ${sel === 'all' ? 'sel' : ''}`} onClick={() => onSel('all')} onContextMenu={e => openMenu(e, null)}>
        <span className="tw" /><span>🗂️</span><span className="nm">All documents</span><span className={`ct ${countsLoading ? 'ld' : ''}`}>{countsLoading ? '…' : total}</span>
      </div>
      {roots.map(r => <Row key={r.idGroup} node={r} depth={0} sel={sel} onSel={onSel} open={open} toggle={toggle} onMenu={openMenu} busy={countsLoading} />)}
      <div className="sep" style={{ height: 1, background: 'var(--line)', margin: '8px 4px' }} />
      <div className={`tree-row ${sel === 'expired' ? 'sel' : ''}`} onClick={() => onSel('expired')}>
        <span className="tw" /><span>⛔</span><span className="nm">Expired documents</span><span className={`ct ${countsLoading ? 'ld' : ''}`}>{countsLoading ? '…' : expired}</span>
      </div>
      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={items(ctx.node)} onPick={pick} onClose={() => setCtx(null)} />}
    </div>
  );
}
