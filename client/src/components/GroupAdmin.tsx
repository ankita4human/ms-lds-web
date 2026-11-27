import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type GroupNode } from '../api';
import ConfirmDialog from './ConfirmDialog';
import { PageLoader, Spinner } from './Loader';
import { tr } from '../i18n';

export type GroupAction = { kind: 'new' | 'rename' | 'delete' | 'owner' | 'order'; node: GroupNode | null };   // node null = the root

type Props = { action: GroupAction; lang: string; onClose: () => void; onDone: (msg: string, ok?: boolean, selectId?: number) => void };

const errText = (e: unknown) => (e instanceof Error ? e.message : tr('The action failed.'));

export default function GroupAdmin({ action, lang, onClose, onDone }: Props) {
  const { kind, node } = action;
  if (kind === 'new' || kind === 'rename') return <NameDialog kind={kind} node={node} lang={lang} onClose={onClose} onDone={onDone} />;
  if (kind === 'owner' && node) return <OwnerDialog node={node} lang={lang} onClose={onClose} onDone={onDone} />;
  if (kind === 'order') return <OrderDialog node={node} lang={lang} onClose={onClose} onDone={onDone} />;
  if (kind === 'delete' && node) return <DeleteDialog node={node} lang={lang} onClose={onClose} onDone={onDone} />;
  return null;
}

function Shell({ title, sub, busy, onClose, children, foot }: { title: string; sub?: string; busy?: boolean; onClose: () => void; children: React.ReactNode; foot: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [busy, onClose]);
  return (
    <div className="modal-back" onMouseDown={() => !busy && onClose()}>
      <div className="modal grp-dlg" role="dialog" aria-modal="true" aria-label={title} onMouseDown={e => e.stopPropagation()}>
        <div><h3 style={{ margin: 0 }}>{title}</h3>{sub && <div className="mh" style={{ marginTop: 2 }}>{sub}</div>}</div>
        {children}
        <div className="modal-foot">{foot}</div>
      </div>
    </div>
  );
}

function NameDialog({ kind, node, lang, onClose, onDone }: { kind: 'new' | 'rename'; node: GroupNode | null; lang: string; onClose: () => void; onDone: Props['onDone'] }) {
  const [name, setName] = useState(kind === 'rename' ? node?.name ?? '' : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  async function save() {
    const n = name.trim();
    if (!n) { setErr(tr('Please enter a group name.')); return; }
    setBusy(true); setErr('');
    try {
      if (kind === 'new') {
        const r = await api.createGroup(lang, node?.idGroup ?? 0, n);
        onDone(tr('Group “{0}” was created.', n), true, r.idGroup);
      } else {
        await api.renameGroup(node!.idGroup, lang, n);
        onDone(tr('The group was renamed to “{0}”.', n));
      }
    } catch (e) { setErr(errText(e)); setBusy(false); }
  }
  return (
    <Shell title={kind === 'new' ? (node ? tr('New sub-group') : tr('New group')) : tr('Rename group')} busy={busy} onClose={onClose}
      sub={kind === 'new' ? (node ? tr('Inside “{0}”', node.name) : tr('A new main group')) : tr('Current name: {0}', node?.name)}
      foot={<><button className="btn-ghost" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
        <button className="btn-primary" style={{ width: 'auto' }} onClick={save} disabled={busy}>{busy ? <><Spinner />{tr('Saving')}</> : kind === 'new' ? tr('Create group') : tr('Rename')}</button></>}>
      <label className="fld"><span>{tr('Group name (')}{lang})</span>
        <input ref={ref} value={name} maxLength={240} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && !busy && save()} /></label>
      <div className="mh">{tr('The name is stored for')}{' '}{lang}{tr('; the other languages show it as “<')}{lang}{tr('>name” until they are translated.')}</div>
      {err && <div className="card error" role="alert" style={{ padding: 10 }}>{err}</div>}
    </Shell>
  );
}

function DeleteDialog({ node, lang, onClose, onDone }: { node: GroupNode; lang: string; onClose: () => void; onDone: Props['onDone'] }) {
  const [busy, setBusy] = useState(false);
  return (
    <ConfirmDialog title={tr('Delete group')} danger confirmLabel={tr('Delete')} busy={busy} onCancel={onClose}
      message={<>{tr('Delete the group')}{' '}<b>{node.name}</b>{tr('? This cannot be undone. A group can only be deleted when it has no sub-groups and no documents.')}</>}
      onConfirm={async () => {
        setBusy(true);
        try { await api.deleteGroup(node.idGroup, lang); onDone(tr('Group “{0}” was deleted.', node.name)); }
        catch (e) { onDone(errText(e), false); }
      }} />
  );
}

function OwnerDialog({ node, lang, onClose, onDone }: { node: GroupNode; lang: string; onClose: () => void; onDone: Props['onDone'] }) {
  const owners = useQuery({ queryKey: ['process-owners'], queryFn: api.processOwners });
  const [owner, setOwner] = useState(node.idProcessOwner ?? 0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function save() {
    setBusy(true); setErr('');
    try {
      const r = await api.setGroupOwner(node.idGroup, lang, owner);
      onDone(owner ? tr('The process owner of “{0}” was set{1}.', node.name, r.documentsUpdated ? `; ${r.documentsUpdated} draft document(s) now have the same owner` : '') : tr('The process owner of “{0}” was cleared.', node.name));
    } catch (e) { setErr(errText(e)); setBusy(false); }
  }
  return (
    <Shell title={tr('Assign process owner')} sub={node.name} busy={busy} onClose={onClose}
      foot={<><button className="btn-ghost" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
        <button className="btn-primary" style={{ width: 'auto' }} onClick={save} disabled={busy || owners.isLoading}>{busy ? <><Spinner />{tr('Saving')}</> : tr('Assign')}</button></>}>
      {owners.isLoading ? <PageLoader compact label={tr('Loading process owners')} /> : (
        <label className="fld"><span>{tr('Process owner')}</span>
          <select value={owner} onChange={e => setOwner(Number(e.target.value))}>
            <option value={0}>{tr('— none —')}</option>
            {owners.data?.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select></label>
      )}
      <div className="mh">{tr('All users with “Process owner” ticked in User management are listed. Documents of this group that are still in Draft or Edit status get the same process owner.')}</div>
      {(err || owners.isError) && <div className="card error" role="alert" style={{ padding: 10 }}>{err || tr('Could not load the process owners.')}</div>}
    </Shell>
  );
}

type Row = { id: number; name: string; note?: string; canMove?: boolean };

function OrderDialog({ node, lang, onClose, onDone }: { node: GroupNode | null; lang: string; onClose: () => void; onDone: Props['onDone'] }) {
  const id = node?.idGroup ?? 0;
  const data = useQuery({ queryKey: ['group-order', id, lang], queryFn: () => api.groupOrder(id, lang), gcTime: 0, staleTime: 0 });
  const [tab, setTab] = useState<'groups' | 'docs'>('groups');
  const [groups, setGroups] = useState<Row[] | null>(null);
  const [docs, setDocs] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [drag, setDrag] = useState<number | null>(null);
  useEffect(() => {
    if (!data.data) return;
    setGroups(data.data.groups.map(g => ({ id: g.id, name: g.name, canMove: g.canMove })));
    setDocs(data.data.docs.map(d => ({ id: d.id, name: d.name, note: `#${d.id}`, canMove: true })));
    if (data.data.groups.length === 0 && data.data.docs.length > 0) setTab('docs');
  }, [data.data]);

  const rows = tab === 'groups' ? groups : docs;
  const setRows = tab === 'groups' ? setGroups : setDocs;
  const move = (from: number, to: number) => setRows(r => {
    if (!r || to < 0 || to >= r.length || from === to) return r;
    const n = [...r]; const [x] = n.splice(from, 1); n.splice(to, 0, x); return n;
  });
  async function save() {
    setBusy(true); setErr('');
    try {
      await api.saveGroupOrder(id, lang, (groups ?? []).map(g => g.id), (docs ?? []).map(d => d.id));
      onDone(tr('The order {0} was saved.', node ? `inside “${node.name}”` : 'of the main groups'));
    } catch (e) { setErr(errText(e)); setBusy(false); }
  }
  const nothing = !data.isLoading && (groups?.length ?? 0) === 0 && (docs?.length ?? 0) === 0;
  return (
    <Shell title={tr('Change order')} sub={node ? node.name : tr('Main groups')} busy={busy} onClose={onClose}
      foot={<><button className="btn-ghost" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
        <button className="btn-primary" style={{ width: 'auto' }} onClick={save} disabled={busy || data.isLoading || nothing}>{busy ? <><Spinner />{tr('Saving')}</> : tr('Save order')}</button></>}>
      {node && <div className="ord-tabs">
        <button className={tab === 'groups' ? 'on' : ''} onClick={() => setTab('groups')}>{tr('Sub-groups')}<em>{groups?.length ?? 0}</em></button>
        <button className={tab === 'docs' ? 'on' : ''} onClick={() => setTab('docs')}>{tr('Documents')}<em>{docs?.length ?? 0}</em></button>
      </div>}
      {data.isLoading && <PageLoader compact label={tr('Loading')} />}
      {data.isError && <div className="card error" role="alert" style={{ padding: 10 }}>{errText(data.error)}</div>}
      {nothing && <div className="mh">{tr('There is nothing to arrange here.')}</div>}
      {rows && rows.length > 0 && (
        <ul className="ord-list" aria-label={tr('Drag the rows or use the arrows')}>
          {rows.map((r, i) => (
            <li key={r.id} className={`${drag === i ? 'drag' : ''} ${r.canMove === false ? 'lock' : ''}`} draggable={r.canMove !== false}
              onDragStart={() => setDrag(i)} onDragOver={e => { e.preventDefault(); if (drag !== null && drag !== i) { move(drag, i); setDrag(i); } }} onDragEnd={() => setDrag(null)}>
              <span className="ord-grip" aria-hidden="true">⠿</span>
              <span className="ord-no">{i + 1}</span>
              <span className="ord-nm" title={r.name}>{r.name}</span>
              {r.note && <span className="ord-note">{r.note}</span>}
              {r.canMove === false && <span className="ord-note" title={tr('You have no full access to this group; its position is not changed')}>🔒</span>}
              <button className="ord-btn" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label={tr('Move up')}>▲</button>
              <button className="ord-btn" onClick={() => move(i, i + 1)} disabled={i === rows.length - 1} aria-label={tr('Move down')}>▼</button>
            </li>
          ))}
        </ul>
      )}
      {err && <div className="card error" role="alert" style={{ padding: 10 }}>{err}</div>}
    </Shell>
  );
}
