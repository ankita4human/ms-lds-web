import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DocRow, type GroupNode } from '../api';
import ConfirmDialog from './ConfirmDialog';
import { PageLoader, Spinner } from './Loader';
import VersionPicker, { verText, type Ver } from './VersionPicker';

const errText = (e: unknown) => (e instanceof Error ? e.message : 'The action failed.');
const refresh = (qc: ReturnType<typeof useQueryClient>) =>
  Promise.all(['docs', 'doc', 'doc-deep', 'stats', 'groups'].map(k => qc.invalidateQueries({ queryKey: [k] })));

function Modal({ title, sub, busy, onClose, children, foot, wide }: {
  title: string; sub?: string; busy?: boolean; onClose: () => void; children: React.ReactNode; foot: React.ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [busy, onClose]);
  return (
    <div className="modal-back" onMouseDown={() => !busy && onClose()}>
      <div className="modal grp-dlg" style={wide ? { width: 560 } : undefined} role="dialog" aria-modal="true" aria-label={title} onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head"><div><h3 style={{ margin: 0 }}>{title}</h3>{sub && <div className="mh" style={{ marginTop: 2 }}>{sub}</div>}</div>
          <button className="x" onClick={onClose} disabled={busy} aria-label="Close">✕</button></div>
        {children}
        <div className="modal-foot">{foot}</div>
      </div>
    </div>
  );
}

/** "Choose Group" window (manual p. 105): the folder tree; groups without full access are greyed out. */
export function FolderPicker({ groups, value, onChange, exclude }: { groups: GroupNode[]; value: number | null; onChange: (id: number) => void; exclude?: Set<number> }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<number>>(new Set());
  const kids = useMemo(() => {
    const m = new Map<number, GroupNode[]>();
    for (const g of groups) { const a = m.get(g.idParent) ?? []; a.push(g); m.set(g.idParent, a); }
    return m;
  }, [groups]);
  const byId = useMemo(() => new Map(groups.map(g => [g.idGroup, g])), [groups]);
  // open the folders above the chosen one
  useEffect(() => {
    if (value == null) return;
    const s = new Set<number>(); let c = byId.get(value)?.idParent ?? 0, n = 0;
    while (c && n++ < 50) { s.add(c); c = byId.get(c)?.idParent ?? 0; }
    setOpen(o => new Set([...o, ...s]));
  }, [value, byId]);
  const path = (g: GroupNode) => { const p: string[] = []; let c: GroupNode | undefined = g, n = 0; while (c && n++ < 50) { p.unshift(c.name); c = byId.get(c.idParent); } return p.join(' / '); };
  const filtered = q.trim() ? groups.filter(g => path(g).toLowerCase().includes(q.trim().toLowerCase())) : null;
  const row = (g: GroupNode, depth: number, label?: string) => {
    const ok = g.accessible && !exclude?.has(g.idGroup);
    const has = (kids.get(g.idGroup)?.length ?? 0) > 0;
    return (
      <div key={g.idGroup} className={`tree-row ${value === g.idGroup ? 'sel' : ''} ${ok ? '' : 'dim'}`} style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => ok && onChange(g.idGroup)} onDoubleClick={() => has && setOpen(o => { const n = new Set(o); n.has(g.idGroup) ? n.delete(g.idGroup) : n.add(g.idGroup); return n; })}
        title={ok ? path(g) : exclude?.has(g.idGroup) ? 'Already assigned' : 'No full access to this group'}>
        <span className="tw" onClick={e => { e.stopPropagation(); if (has) setOpen(o => { const n = new Set(o); n.has(g.idGroup) ? n.delete(g.idGroup) : n.add(g.idGroup); return n; }); }}>
          {has && !filtered ? (open.has(g.idGroup) ? '▾' : '▸') : ''}</span>
        <span>{open.has(g.idGroup) && has ? '📂' : '📁'}</span><span className="nm">{label ?? g.name}</span>
      </div>
    );
  };
  const walk = (parent: number, depth: number): React.ReactNode =>
    (kids.get(parent) ?? []).slice().sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)).map(g => (
      <div key={g.idGroup}>{row(g, depth)}{open.has(g.idGroup) && walk(g.idGroup, depth + 1)}</div>));
  return (
    <div className="fp">
      <input className="fp-q" placeholder="Search folder…" value={q} onChange={e => setQ(e.target.value)} />
      <div className="fp-list" role="tree">
        {filtered ? filtered.slice(0, 200).map(g => row(g, 0, path(g))) : walk(0, 0)}
        {filtered && filtered.length === 0 && <div className="mh" style={{ padding: 8 }}>No folder found.</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ COPY (manual p. 103)
export function CopyDialog({ doc, lang, groups, defaultGroup, onClose, onDone }: {
  doc: DocRow; lang: string; groups: GroupNode[]; defaultGroup: number | null; onClose: () => void; onDone: (newId: number, name: string) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(doc.docName);
  const [ver, setVer] = useState<Ver>({ v1: doc.v1 ?? 0, v2: doc.v2 ?? 0, v3: doc.v3 ?? 0 });
  const [group, setGroup] = useState<number | null>(defaultGroup);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const noVer = ver.v1 + ver.v2 + ver.v3 === 0;
  async function save() {
    if (!name.trim()) { setErr('Please enter a name for the copy.'); return; }
    if (noVer) { setErr('The version must be at least 0.0.1.'); return; }
    if (group == null) { setErr('Please choose the folder for the copy.'); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.copyDoc(doc.idDoc, { lang, groupId: group, name: name.trim(), ...ver });
      await refresh(qc); onDone(r.idDoc, r.name);
    } catch (e) { setErr(errText(e)); setBusy(false); }
  }
  return (
    <Modal title="Copy document" sub={`#${doc.idDoc} ${doc.docName}`} busy={busy} onClose={onClose} wide
      foot={<><button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn-primary" style={{ width: 'auto' }} onClick={save} disabled={busy}>{busy ? <><Spinner />Copying</> : 'Copy'}</button></>}>
      <label className="fld"><span>Name of the copy</span>
        <input ref={ref} value={name} maxLength={70} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && !busy && save()} /></label>
      <div className="fld"><span>Version of the copy ({verText(ver)})</span>
        <VersionPicker value={ver} onChange={setVer} /></div>
      <div className="fld"><span>Folder</span><FolderPicker groups={groups} value={group} onChange={setGroup} /></div>
      <div className="mh">The copy starts as a Draft with the file of every language. The distribution list is copied as well (DB Tool setting).</div>
      {err && <div className="card error" role="alert" style={{ padding: 10 }}>{err}</div>}
    </Modal>
  );
}

// ------------------------------------------------------------------ ASSIGNMENT (manual p. 104)
export function AssignDialog({ doc, lang, groups, onClose, onChanged }: {
  doc: DocRow; lang: string; groups: GroupNode[]; onClose: () => void; onChanged: (msg: string) => void;
}) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['doc-assign', doc.idDoc, lang], queryFn: () => api.docAssignments(doc.idDoc, lang), gcTime: 0 });
  const [group, setGroup] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [confirmRm, setConfirmRm] = useState<number | null>(null);
  const linked = useMemo(() => new Set(list.data?.items.map(i => i.idGroup) ?? []), [list.data]);
  const changed = useRef(false);
  async function after(msg: string) { changed.current = true; await Promise.all([list.refetch(), refresh(qc)]); onChanged(msg); }
  async function add() {
    if (group == null) { setErr('Please choose a folder.'); return; }
    setBusy(true); setErr('');
    try { const r = await api.addAssignment(doc.idDoc, lang, group); setGroup(null); await after(r.added ? 'The document was assigned to the folder.' : 'The document is already assigned to that folder.'); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  async function remove(g: number) {
    setBusy(true); setErr('');
    try { await api.removeAssignment(doc.idDoc, lang, g); await after('The link to the folder was removed.'); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); setConfirmRm(null); }
  }
  const only = (list.data?.items.length ?? 0) <= 1 && !(list.data?.hidden);
  return (
    <Modal title="Assignments" sub={`#${doc.idDoc} ${doc.docName}`} busy={busy} onClose={onClose} wide
      foot={<button className="btn-primary" style={{ width: 'auto' }} onClick={onClose} disabled={busy}>Close</button>}>
      <div className="fld"><span>Assigned to</span>
        {list.isLoading ? <PageLoader compact label="Loading" /> : (
          <ul className="asg-list">
            {list.data?.items.map(i => (
              <li key={i.idGroup}>
                <span className="asg-main" title="Main group">{i.main}</span>
                <span className="asg-path" title={i.path}>{i.path}</span>
                <span className="ord-note">ID {i.idGroup}</span>
                <button className="btn-ghost" style={{ padding: '3px 10px', fontSize: 12 }} disabled={busy} onClick={() => setConfirmRm(i.idGroup)}>Remove link</button>
              </li>))}
            {list.data?.items.length === 0 && <li className="mh">The document is not assigned to any folder you can see.</li>}
            {!!list.data?.hidden && <li className="mh">+ {list.data.hidden} folder(s) you have no access to.</li>}
          </ul>)}
      </div>
      <div className="fld"><span>Assign to another folder (choose, then “Assign”)</span>
        <FolderPicker groups={groups} value={group} onChange={setGroup} exclude={linked} /></div>
      <div><button className="btn-primary" style={{ width: 'auto' }} onClick={add} disabled={busy || group == null}>{busy ? <><Spinner />Working</> : 'Assign to the chosen folder'}</button></div>
      <div className="mh">One document can be assigned to several folders. To move it, assign the new folder and remove the old link.</div>
      {err && <div className="card error" role="alert" style={{ padding: 10 }}>{err}</div>}
      {confirmRm != null && <ConfirmDialog title="Remove link" confirmLabel="Remove link" danger busy={busy} onCancel={() => setConfirmRm(null)} onConfirm={() => remove(confirmRm)}
        message={only ? <>This is the only folder of the document. After removing the link it will not appear in any folder.</> : <>Remove the link between the document and this folder? The document itself is not deleted.</>} />}
    </Modal>
  );
}

// ------------------------------------------------------------------ RENAME (manual p. 106)
export function RenameDialog({ doc, lang, onClose, onDone }: {
  doc: DocRow; lang: string; onClose: () => void; onDone: (msg: string) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(doc.docName);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  async function save() {
    const n = name.trim();
    if (!n) { setErr('Please enter a document name.'); return; }
    if (n === doc.docName) { onClose(); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.renameDoc(doc.idDoc, { lang, name: n });
      await refresh(qc);
      if (r.republish) window.dispatchEvent(new Event('pl-publish-queued'));
      onDone(`The document was renamed to “${r.name}”.${r.republish ? ' It is published again; the bell at the top shows the progress.' : ''}`);
    } catch (e) { setErr(errText(e)); setBusy(false); }
  }
  return (
    <Modal title="Rename document" sub={`#${doc.idDoc} · ${lang}`} busy={busy} onClose={onClose}
      foot={<><button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn-primary" style={{ width: 'auto' }} onClick={save} disabled={busy}>{busy ? <><Spinner />Saving</> : 'Rename'}</button></>}>
      <label className="fld"><span>Document name</span>
        <input ref={ref} value={name} maxLength={80} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && !busy && save()} /></label>
      {doc.status === 3 && <div className="mh">The document is published: after renaming it goes to the publishing queue automatically.</div>}
      {err && <div className="card error" role="alert" style={{ padding: 10 }}>{err}</div>}
    </Modal>
  );
}

// ------------------------------------------------------------------ DELETE (manual p. 107)
export function DeleteDialog({ doc, lang, onClose, onDone }: {
  doc: DocRow; lang: string; onClose: () => void; onDone: (msg: string, ok: boolean) => void;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  return (
    <ConfirmDialog title="Confirm deletion" danger confirmLabel="Yes, delete" busy={busy} onCancel={onClose}
      message={<>Delete document <b>#{doc.idDoc} {doc.docName}</b> in all languages? It moves to the deleted documents list (archive); the file and the published copies are removed.</>}
      onConfirm={async () => {
        setBusy(true);
        try {
          const r = await api.deleteDoc(doc.idDoc, lang);
          await refresh(qc);
          onDone(`Document ${doc.idDoc} was deleted.${r.warnings?.length ? ' ' + r.warnings.join(' ') : ''}`, true);
        } catch (e) { onDone(errText(e), false); }
      }} />
  );
}
