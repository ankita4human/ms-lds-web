import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type GroupNode } from '../api';
import ConfirmDialog from './ConfirmDialog';
import { PageLoader, Spinner } from './Loader';

export type GroupAction = { kind: 'new' | 'rename' | 'delete' | 'owner' | 'order'; node: GroupNode | null };   // node null = the root

type Props = { action: GroupAction; lang: string; onClose: () => void; onDone: (msg: string, ok?: boolean, selectId?: number) => void };

const errText = (e: unknown) => (e instanceof Error ? e.message : 'The action failed.');

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
    if (!n) { setErr('Please enter a group name.'); return; }
    setBusy(true); setErr('');
    try {
      if (kind === 'new') {
        const r = await api.createGroup(lang, node?.idGroup ?? 0, n);
        onDone(`Group “${n}” was created.`, true, r.idGroup);
      } else {
        await api.renameGroup(node!.idGroup, lang, n);
        onDone(`The group was renamed to “${n}”.`);
      }
    } catch (e) { setErr(errText(e)); setBusy(false); }
  }
  return (
    <Shell title={kind === 'new' ? (node ? 'New sub-group' : 'New group') : 'Rename group'} busy={busy} onClose={onClose}
      sub={kind === 'new' ? (node ? `Inside “${node.name}”` : 'A new main group') : `Current name: ${node?.name}`}
      foot={<><button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn-primary" style={{ width: 'auto' }} onClick={save} disabled={busy}>{busy ? <><Spinner />Saving</> : kind === 'new' ? 'Create group' : 'Rename'}</button></>}>
      <label className="fld"><span>Group name ({lang})</span>
        <input ref={ref} value={name} maxLength={240} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && !busy && save()} /></label>
      <div className="mh">The name is stored for {lang}; the other languages show it as “&lt;{lang}&gt;name” until they are translated.</div>
      {err && <div className="card error" role="alert" style={{ padding: 10 }}>{err}</div>}
    </Shell>
  );
}

function DeleteDialog({ node, lang, onClose, onDone }: { node: GroupNode; lang: string; onClose: () => void; onDone: Props['onDone'] }) {
  const [busy, setBusy] = useState(false);
  return (
    <ConfirmDialog title="Delete group" danger confirmLabel="Delete" busy={busy} onCancel={onClose}
      message={<>Delete the group <b>{node.name}</b>? This cannot be undone. A group can only be deleted when it has no sub-groups and no documents.</>}
      onConfirm={async () => {
        setBusy(true);
        try { await api.deleteGroup(node.idGroup, lang); onDone(`Group “${node.name}” was deleted.`); }
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
      onDone(owner ? `The process owner of “${node.name}” was set${r.documentsUpdated ? `; ${r.documentsUpdated} draft document(s) now have the same owner` : ''}.` : `The process owner of “${node.name}” was cleared.`);
    } catch (e) { setErr(errText(e)); setBusy(false); }
  }
  return (
    <Shell title="Assign process owner" sub={node.name} busy={busy} onClose={onClose}
      foot={<><button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn-primary" style={{ width: 'auto' }} onClick={save} disabled={busy || owners.isLoading}>{busy ? <><Spinner />Saving</> : 'Assign'}</button></>}>
      {owners.isLoading ? <PageLoader compact label="Loading process owners" /> : (
        <label className="fld"><span>Process owner</span>
          <select value={owner} onChange={e => setOwner(Number(e.target.value))}>
            <option value={0}>— none —</option>
            {owners.data?.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select></label>
      )}
      <div className="mh">All users with “Process owner” ticked in User management are listed. Documents of this group that are still in Draft or Edit status get the same process owner.</div>
      {(err || owners.isError) && <div className="card error" role="alert" style={{ padding: 10 }}>{err || 'Could not load the process owners.'}</div>}
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
      onDone(`The order ${node ? `inside “${node.name}”` : 'of the main groups'} was saved.`);
    } catch (e) { setErr(errText(e)); setBusy(false); }
  }
  const nothing = !data.isLoading && (groups?.length ?? 0) === 0 && (docs?.length ?? 0) === 0;
  return (
    <Shell title="Change order" sub={node ? node.name : 'Main groups'} busy={busy} onClose={onClose}
      foot={<><button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn-primary" style={{ width: 'auto' }} onClick={save} disabled={busy || data.isLoading || nothing}>{busy ? <><Spinner />Saving</> : 'Save order'}</button></>}>
      {node && <div className="ord-tabs">
        <button className={tab === 'groups' ? 'on' : ''} onClick={() => setTab('groups')}>Sub-groups<em>{groups?.length ?? 0}</em></button>
        <button className={tab === 'docs' ? 'on' : ''} onClick={() => setTab('docs')}>Documents<em>{docs?.length ?? 0}</em></button>
      </div>}
      {data.isLoading && <PageLoader compact label="Loading" />}
      {data.isError && <div className="card error" role="alert" style={{ padding: 10 }}>{errText(data.error)}</div>}
      {nothing && <div className="mh">There is nothing to arrange here.</div>}
      {rows && rows.length > 0 && (
        <ul className="ord-list" aria-label="Drag the rows or use the arrows">
          {rows.map((r, i) => (
            <li key={r.id} className={`${drag === i ? 'drag' : ''} ${r.canMove === false ? 'lock' : ''}`} draggable={r.canMove !== false}
              onDragStart={() => setDrag(i)} onDragOver={e => { e.preventDefault(); if (drag !== null && drag !== i) { move(drag, i); setDrag(i); } }} onDragEnd={() => setDrag(null)}>
              <span className="ord-grip" aria-hidden="true">⠿</span>
              <span className="ord-no">{i + 1}</span>
              <span className="ord-nm" title={r.name}>{r.name}</span>
              {r.note && <span className="ord-note">{r.note}</span>}
              {r.canMove === false && <span className="ord-note" title="You have no full access to this group; its position is not changed">🔒</span>}
              <button className="ord-btn" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label="Move up">▲</button>
              <button className="ord-btn" onClick={() => move(i, i + 1)} disabled={i === rows.length - 1} aria-label="Move down">▼</button>
            </li>
          ))}
        </ul>
      )}
      {err && <div className="card error" role="alert" style={{ padding: 10 }}>{err}</div>}
    </Shell>
  );
}
