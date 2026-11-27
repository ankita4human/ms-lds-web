import { useEffect, useMemo, useRef, useState } from 'react';
import './blockdlg.css';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type DocRow, type GroupNode } from '../api';
import ConfirmDialog from './ConfirmDialog';
import { PageLoader, Spinner } from './Loader';
import VersionPicker, { verText, type Ver } from './VersionPicker';
import { tr } from '../i18n';

const errText = (e: unknown) => (e instanceof Error ? e.message : tr('The action failed.'));
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
          <button className="x" onClick={onClose} disabled={busy} aria-label={tr('Close')}>✕</button></div>
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
        title={ok ? path(g) : exclude?.has(g.idGroup) ? tr('Already assigned') : tr('No full access to this group')}>
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
      <input className="fp-q" placeholder={tr('Search folder…')} value={q} onChange={e => setQ(e.target.value)} />
      <div className="fp-list" role="tree">
        {filtered ? filtered.slice(0, 200).map(g => row(g, 0, path(g))) : walk(0, 0)}
        {filtered && filtered.length === 0 && <div className="mh" style={{ padding: 8 }}>{tr('No folder found.')}</div>}
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
    if (!name.trim()) { setErr(tr('Please enter a name for the copy.')); return; }
    if (noVer) { setErr(tr('The version must be at least 0.0.1.')); return; }
    if (group == null) { setErr(tr('Please choose the folder for the copy.')); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.copyDoc(doc.idDoc, { lang, groupId: group, name: name.trim(), ...ver });
      await refresh(qc); onDone(r.idDoc, r.name);
    } catch (e) { setErr(errText(e)); setBusy(false); }
  }
  return (
    <Modal title={tr('Copy document')} sub={`#${doc.idDoc} ${doc.docName}`} busy={busy} onClose={onClose} wide
      foot={<><button className="btn-ghost" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
        <button className="btn-primary" style={{ width: 'auto' }} onClick={save} disabled={busy}>{busy ? <><Spinner />{tr('Copying')}</> : tr('Copy')}</button></>}>
      <label className="fld"><span>{tr('Name of the copy')}</span>
        <input ref={ref} value={name} maxLength={70} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && !busy && save()} /></label>
      <div className="fld"><span>{tr('Version of the copy (')}{verText(ver)})</span>
        <VersionPicker value={ver} onChange={setVer} /></div>
      <div className="fld"><span>{tr('Folder')}</span><FolderPicker groups={groups} value={group} onChange={setGroup} /></div>
      <div className="mh">{tr('The copy starts as a Draft with the file of every language. The distribution list is copied as well (DB Tool setting).')}</div>
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
    if (group == null) { setErr(tr('Please choose a folder.')); return; }
    setBusy(true); setErr('');
    try { const r = await api.addAssignment(doc.idDoc, lang, group); setGroup(null); await after(r.added ? tr('The document was assigned to the folder.') : tr('The document is already assigned to that folder.')); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  async function remove(g: number) {
    setBusy(true); setErr('');
    try { await api.removeAssignment(doc.idDoc, lang, g); await after(tr('The link to the folder was removed.')); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); setConfirmRm(null); }
  }
  const only = (list.data?.items.length ?? 0) <= 1 && !(list.data?.hidden);
  return (
    <Modal title={tr('Assignments')} sub={`#${doc.idDoc} ${doc.docName}`} busy={busy} onClose={onClose} wide
      foot={<button className="btn-primary" style={{ width: 'auto' }} onClick={onClose} disabled={busy}>{tr('Close')}</button>}>
      <div className="fld"><span>{tr('Assigned to')}</span>
        {list.isLoading ? <PageLoader compact label={tr('Loading')} /> : (
          <ul className="asg-list">
            {list.data?.items.map(i => (
              <li key={i.idGroup}>
                <span className="asg-main" title={tr('Main group')}>{i.main}</span>
                <span className="asg-path" title={i.path}>{i.path}</span>
                <span className="ord-note">{tr('ID')}{' '}{i.idGroup}</span>
                <button className="btn-ghost" style={{ padding: '3px 10px', fontSize: 12 }} disabled={busy} onClick={() => setConfirmRm(i.idGroup)}>{tr('Remove link')}</button>
              </li>))}
            {list.data?.items.length === 0 && <li className="mh">{tr('The document is not assigned to any folder you can see.')}</li>}
            {!!list.data?.hidden && <li className="mh">+ {list.data.hidden} {tr('folder(s) you have no access to.')}</li>}
          </ul>)}
      </div>
      <div className="fld"><span>{tr('Assign to another folder (choose, then “Assign”)')}</span>
        <FolderPicker groups={groups} value={group} onChange={setGroup} exclude={linked} /></div>
      <div><button className="btn-primary" style={{ width: 'auto' }} onClick={add} disabled={busy || group == null}>{busy ? <><Spinner />{tr('Working')}</> : tr('Assign to the chosen folder')}</button></div>
      <div className="mh">{tr('One document can be assigned to several folders. To move it, assign the new folder and remove the old link.')}</div>
      {err && <div className="card error" role="alert" style={{ padding: 10 }}>{err}</div>}
      {confirmRm != null && <ConfirmDialog title={tr('Remove link')} confirmLabel={tr('Remove link')} danger busy={busy} onCancel={() => setConfirmRm(null)} onConfirm={() => remove(confirmRm)}
        message={only ? <>{tr('This is the only folder of the document. After removing the link it will not appear in any folder.')}</> : <>{tr('Remove the link between the document and this folder? The document itself is not deleted.')}</>} />}
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
    if (!n) { setErr(tr('Please enter a document name.')); return; }
    if (n === doc.docName) { onClose(); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.renameDoc(doc.idDoc, { lang, name: n });
      await refresh(qc);
      if (r.republish) window.dispatchEvent(new Event('pl-publish-queued'));
      onDone(tr('The document was renamed to “{0}”.{1}', r.name, r.republish ? ' It is published again; the bell at the top shows the progress.' : ''));
    } catch (e) { setErr(errText(e)); setBusy(false); }
  }
  return (
    <Modal title={tr('Rename document')} sub={`#${doc.idDoc} · ${lang}`} busy={busy} onClose={onClose}
      foot={<><button className="btn-ghost" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
        <button className="btn-primary" style={{ width: 'auto' }} onClick={save} disabled={busy}>{busy ? <><Spinner />{tr('Saving')}</> : tr('Rename')}</button></>}>
      <label className="fld"><span>{tr('Document name')}</span>
        <input ref={ref} value={name} maxLength={80} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && !busy && save()} /></label>
      {doc.status === 3 && <div className="mh">{tr('The document is published: after renaming it goes to the publishing queue automatically.')}</div>}
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
    <ConfirmDialog title={tr('Confirm deletion')} danger confirmLabel={tr('Yes, delete')} busy={busy} onCancel={onClose}
      message={<>{tr('Delete document')}{' '}<b>#{doc.idDoc} {doc.docName}</b> {tr('in all languages? It moves to the deleted documents list (archive); the file and the published copies are removed.')}</>}
      onConfirm={async () => {
        setBusy(true);
        try {
          const r = await api.deleteDoc(doc.idDoc, lang);
          await refresh(qc);
          onDone(tr('Document {0} was deleted.{1}', doc.idDoc, r.warnings?.length ? ' ' + r.warnings.join(' ') : ''), true);
        } catch (e) { onDone(errText(e), false); }
      }} />
  );
}

/** Block / Unblock (manual p. 94-96, 127): a reason is entered (spaces skip it); blocked documents are not usable in MS LDS and the web. */
export function BlockDialog({ doc, lang, onClose, onDone }: {
  doc: DocRow; lang: string; onClose: () => void; onDone: (msg: string, ok: boolean) => void;
}) {
  const qc = useQueryClient();
  const unblock = doc.status === 9;
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      if (unblock) await api.unblockDoc(doc.idDoc, lang, reason); else await api.blockDoc(doc.idDoc, lang, reason);
      await refresh(qc);
      onDone(unblock ? tr('Document {0} is unblocked and back in Edit status.', doc.idDoc) : tr('Document {0} is blocked in all languages.', doc.idDoc), true);
    } catch (e) { onDone(errText(e), false); }
  }
  const chips = unblock ? [tr('Issue solved'), tr('Blocked by mistake'), tr('Review finished')] : [tr('Outdated content'), tr('Under legal review'), tr('Wrong version published'), tr('Error found')];
  return (
    <Modal title={unblock ? tr('Unblock document') : tr('Block document')} busy={busy} onClose={onClose}
      foot={<><button className="btn-ghost" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
        <button className={`blk-go ${unblock ? 'ok' : 'bad'}`} onClick={go} disabled={busy}>{busy ? <Spinner /> : unblock ? tr('🔓 Unblock document') : tr('⛔ Block document')}</button></>}>
      <div className={`blk ${unblock ? 'ok' : 'bad'}`}>
        <div className="blk-hero">
          <div className="blk-ico" aria-hidden>{unblock ? '🔓' : '⛔'}</div>
          <div className="blk-doc"><b title={doc.docName}>{doc.docName}</b><small>#{doc.idDoc} · {doc.typeName} {tr('· v')}{doc.v1}.{doc.v2}.{doc.v3}</small></div>
        </div>
        <div className="blk-note">
          {unblock
            ? <>{tr('The document goes back to')}{' '}<b>{tr('Edit')}</b> {tr('status in all languages and must be released again.')}</>
            : <>{tr('Blocked documents cannot be used in MS LDS or on the web. Users see')}{' '}<i>{tr('“Document is blocked. Please contact Administrator.”')}</i> {tr('The block applies to')}{' '}<b>{tr('all languages')}</b>.</>}
        </div>
        <label className="blk-lab" htmlFor="blk-reason">{unblock ? tr('Comment (optional)') : tr('Reason to block')}</label>
        <div className="blk-chips">{chips.map(c => <button type="button" key={c} onClick={() => setReason(c)} className={reason === c ? 'on' : ''}>{c}</button>)}</div>
        <textarea id="blk-reason" rows={3} maxLength={450} value={reason} autoFocus onChange={e => setReason(e.target.value)} placeholder={unblock ? tr('Add a short comment…') : tr('Why is this document blocked?')} />
        <div className="blk-count">{reason.length} / 450</div>
      </div>
    </Modal>
  );
}
