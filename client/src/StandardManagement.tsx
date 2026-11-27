import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, type StdNode, type StdXlsxInfo } from './api';
import { useLang } from './LangContext';
import { Spinner, PageLoader } from './components/Loader';
import ConfirmDialog from './components/ConfirmDialog';
import ContextMenu, { type MenuItem } from './components/ContextMenu';
import PageHero from './components/PageHero';
import Toast, { type ToastMsg } from './components/Toast';
import { IconDocs } from './components/Icons';
import { tr } from './i18n';

/** Options > Standard management (manual p. 62-66): standards and their chapters as a tree. Right click on the root: Add New / Import;
 *  on a standard: Add chapter, Mandatory, Remove. Select a node to edit it in the right panel. */
type Menu = { x: number; y: number; node: StdNode | null };
type Form = { name: string; shortName: string; chapterNo: string; description: string; inActive: boolean };
const EMPTY: Form = { name: '', shortName: '', chapterNo: '', description: '', inActive: false };

/** Reads an Excel "save as CSV" (or tab separated) file: chapter number, name, description; a header row is skipped. */
export function parseChapters(text: string): { chapterNo: string; name: string; description: string }[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const first = lines[0]!;
  const sep = first.includes('\t') ? '\t' : (first.split(';').length > first.split(',').length ? ';' : ',');
  const cells = (l: string) => {
    const out: string[] = []; let cur = '', q = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i]!;
      if (q) { if (c === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true; else if (c === sep) { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur); return out.map(x => x.trim());
  };
  let rows = lines.map(cells);
  if (/chapter|kapitel|no\.?$|nr/i.test(rows[0]![0] ?? '') && /name|titel|title|bezeichnung/i.test(rows[0]![1] ?? '')) rows = rows.slice(1);
  return rows.filter(r => (r[1] ?? '').length > 0).map(r => ({ chapterNo: r[0] ?? '', name: r[1] ?? '', description: r[2] ?? '' }));
}

export default function StandardManagement() {
  const { lang } = useLang();
  const qc = useQueryClient();
  const nav = useNavigate();
  const tree = useQuery({ queryKey: ['standards', lang], queryFn: () => api.standards(lang), enabled: !!lang });
  const assoc = useQuery({ queryKey: ['std-assoc'], queryFn: api.stdAssociations });
  const [sel, setSel] = useState<number | 'new' | null>(null);
  const [parent, setParent] = useState(0);                 // parent of the node being added
  const [f, setF] = useState<Form>(EMPTY);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [q, setQ] = useState('');
  const [menu, setMenu] = useState<Menu | null>(null);
  const [askDel, setAskDel] = useState<StdNode | null>(null);
  const [imp, setImp] = useState(false);
  const [mandDlg, setMandDlg] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<ToastMsg>(null);
  const [assocId, setAssocId] = useState(0);
  const [newAssoc, setNewAssoc] = useState('');

  const can = tree.data?.canManage ?? false;
  const nodes = tree.data?.items ?? [];
  const byId = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);
  const kids = useMemo(() => { const m = new Map<number, StdNode[]>(); for (const n of nodes) { const a = m.get(n.parent) ?? []; a.push(n); m.set(n.parent, a); } return m; }, [nodes]);
  const cur = typeof sel === 'number' ? byId.get(sel) : undefined;
  const isRoot = sel === 'new' ? parent === 0 : (cur?.parent ?? 0) === 0;

  // search: show the matching nodes with their parents
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase(); if (!t) return null;
    const s = new Set<number>();
    for (const n of nodes) if (n.name.toLowerCase().includes(t) || n.chapterNo.toLowerCase().includes(t)) { let c: StdNode | undefined = n, g = 0; while (c && g++ < 50) { s.add(c.id); c = byId.get(c.parent); } }
    return s;
  }, [q, nodes, byId]);

  const detail = useQuery({ queryKey: ['standard', sel, lang], queryFn: () => api.standard(sel as number, lang), enabled: typeof sel === 'number' });
  useEffect(() => {
    const d = detail.data; if (!d || d.id !== sel) return;
    setF({ name: d.name, shortName: d.shortName, chapterNo: d.chapterNo, description: d.description, inActive: d.inActive }); setAssocId(d.association);
  }, [detail.data, sel]);

  const refresh = () => Promise.all(['standards', 'standard', 'std-assoc'].map(k => qc.invalidateQueries({ queryKey: [k] })));
  async function run(fn: () => Promise<void>) { setBusy(true); try { await fn(); } catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); } }
  const body = () => ({ lang, parentId: sel === 'new' ? parent : cur?.parent ?? 0, name: f.name.trim(), shortName: f.shortName.trim(), chapterNo: f.chapterNo.trim(), description: f.description.trim(), inActive: f.inActive });

  function startNew(p: number) { setParent(p); setSel('new'); setF(EMPTY); setAssocId(0); if (p) setOpen(o => new Set(o).add(p)); }
  const save = () => run(async () => {
    if (!f.name.trim()) throw new Error(tr('Please enter a name.'));
    if (sel === 'new') { const r = await api.createStandard(body()); await refresh(); setSel(r.id); setMsg({ ok: true, t: isRoot ? tr('Standard added.') : tr('Chapter added.') }); }
    else if (typeof sel === 'number') {
      await api.updateStandard(sel, body());
      if (!isRoot && assocId !== (cur?.association ?? 0)) await api.linkStdAssociation(sel, assocId);
      await refresh(); setMsg({ ok: true, t: tr('Saved.') });
    }
  });
  const remove = (n: StdNode) => run(async () => {
    const r = await api.removeStandard(n.id); await refresh(); setAskDel(null);
    if (sel === n.id) setSel(null);
    setMsg({ ok: true, t: r.removed > 1 ? tr('Removed with {0} chapter(s).', r.removed - 1) : tr('Removed.') });
  });
  const addAssoc = () => run(async () => {
    const n = newAssoc.trim(); if (!n) return;
    const r = await api.createStdAssociation(n); await refresh(); setAssocId(r.id); setNewAssoc('');
  });

  function ctxItems(n: StdNode | null): MenuItem[] {
    if (!n) return [{ key: 'new', label: tr('Add New'), icon: '➕', enabled: can }, { key: 'import', label: tr('Import from file…'), icon: '📥', enabled: can }, { key: 'mand', label: tr('Mandatory Standards…'), icon: '⭐', enabled: can }];
    const root = n.parent === 0;
    return [
      { key: 'chapter', label: root ? tr('Add chapter') : tr('Add sub-chapter'), icon: '➕', enabled: can },
      { key: 'remove', label: tr('Remove'), icon: '🗑️', enabled: can, sepBefore: true },
    ];
  }
  function pick(k: string, n: StdNode | null) {
    if (k === 'new') startNew(0); else if (k === 'import') setImp(true); else if (k === 'mand') setMandDlg(true);
    else if (k === 'chapter' && n) startNew(n.id);
    else if (k === 'remove' && n) setAskDel(n);
  }

  const toggle = (id: number) => setOpen(o => { const s = new Set(o); if (s.has(id)) s.delete(id); else s.add(id); return s; });
  function renderNode(n: StdNode, depth: number): React.ReactNode {
    if (shown && !shown.has(n.id)) return null;
    const ch = kids.get(n.id) ?? []; const isOpen = shown ? true : open.has(n.id);
    return (
      <div key={n.id}>
        <div className={`tree-row ${sel === n.id ? 'sel' : ''}`} style={{ paddingLeft: 8 + depth * 16 }}
          onClick={() => { setSel(n.id); setMsg(null); }} onDoubleClick={() => ch.length && toggle(n.id)}
          onContextMenu={e => { e.preventDefault(); setSel(n.id); setMenu({ x: e.clientX, y: e.clientY, node: n }); }}>
          <span className="tw" onClick={e => { e.stopPropagation(); if (ch.length) toggle(n.id); }}>{ch.length ? (isOpen ? '▾' : '▸') : ''}</span>
          <span aria-hidden="true" style={{ marginRight: 6 }}>{n.parent === 0 || ch.length ? (isOpen ? '📂' : '📁') : '📄'}</span>
          <span className="nm" title={n.name}>{n.chapterNo ? `${n.chapterNo} ` : ''}{n.name}{n.shortName ? ` (${n.shortName})` : ''}</span>
          {n.mandatory && <span title={tr('Mandatory standard')} style={{ marginRight: 4 }}>⭐</span>}
          {n.inActive && <span className="mh" title={tr('Inactive')}>⏸</span>}
          {n.documents > 0 && <span className="ct" title={tr('Linked documents')}>{n.documents}</span>}
        </div>
        {isOpen && ch.map(c => renderNode(c, depth + 1))}
      </div>
    );
  }
  const roots = kids.get(0) ?? [];
  const mandCount = nodes.filter(n => n.mandatory).length;

  return (
    <div className="um">
      <PageHero icon={<IconDocs />} title={tr('Standard management')} sub={tr('Standards, chapters and mandatory standards')}
        chips={[{ n: roots.length, label: 'standards' }, { n: nodes.length - roots.length, label: 'chapters' }, { n: mandCount, label: 'mandatory' }]} />
      <div className="fm" style={{ gridTemplateColumns: '380px 1fr' }}>
        <div className="card fm-list" onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, node: null }); }}>
          <div className="fm-list-head"><b>{tree.data?.rootName ?? tr('Standards')}</b>
            <span><button className="ico-btn add" title={tr('Add new standard')} aria-label={tr('Add new standard')} onClick={() => startNew(0)} disabled={!can}>＋</button>
              <button className="ico-btn" title={tr('Mandatory standards')} aria-label={tr('Mandatory standards')} onClick={() => setMandDlg(true)}>⭐</button>
              <button className="ico-btn" title={tr('Import standard from file')} aria-label={tr('Import standard')} onClick={() => setImp(true)} disabled={!can}>📥</button></span>
          </div>
          <input className="fm-search" value={q} onChange={e => setQ(e.target.value)} placeholder={tr('Search standards and chapters…')} aria-label={tr('Search standards')}
            style={{ width: 'calc(100% - 16px)', margin: '0 8px 8px', padding: '8px 10px', border: '1px solid #d0d5dd', borderRadius: 10, font: 'inherit' }} />
          {tree.isLoading && <PageLoader compact label={tr('Loading standards')} />}
          {roots.map(r => renderNode(r, 0))}
          {tree.data && roots.length === 0 && <div className="mh" style={{ padding: 10 }}>{tr('No standards yet. Right click here and choose Add New, or import a file.')}</div>}
          {shown && shown.size === 0 && <div className="mh" style={{ padding: 10 }}>{tr('Nothing found.')}</div>}
        </div>

        <div className="card fm-edit">
          {sel === null ? <div className="mh" style={{ padding: 20 }}>{tr('Select a standard on the left, or right click and choose Add New.')}{!can && tr(' You may view the standards but not change them (right "Standards management").')}</div> : (
            <fieldset className="fm-box"><legend>{sel === 'new' ? (isRoot ? tr('New standard') : tr('New chapter in {0}', byId.get(parent)?.name ?? '')) : isRoot ? tr('Standard') : tr('Chapter')}</legend>
              <div className="fm-top">
                <div className="fm-fields">
                  <label className="fm-row">{tr('Name')}<input value={f.name} maxLength={240} onChange={e => setF({ ...f, name: e.target.value })} disabled={!can} /></label>
                  {isRoot
                    ? <label className="fm-row">{tr('Short name')}<input value={f.shortName} maxLength={5} onChange={e => setF({ ...f, shortName: e.target.value })} disabled={!can} /></label>
                    : <label className="fm-row">{tr('Chapter No')}<input value={f.chapterNo} maxLength={20} onChange={e => setF({ ...f, chapterNo: e.target.value })} disabled={!can} /></label>}
                  <label className="fm-row">{tr('Description')}<textarea rows={5} value={f.description} onChange={e => setF({ ...f, description: e.target.value })} disabled={!can}
                    style={{ padding: '8px 10px', border: '1px solid #d0d5dd', borderRadius: 10, font: 'inherit', resize: 'vertical' }} /></label>
                  {isRoot && sel !== 'new' && <div className="fm-row">{tr('Status')}<label className="fm-chk"><input type="checkbox" checked={f.inActive} disabled={!can} onChange={e => setF({ ...f, inActive: e.target.checked })} />{tr('Inactive')}</label></div>}
                  {!isRoot && typeof sel === 'number' && (
                    <div className="fm-row">{tr('Linked standards')}<span style={{ display: 'grid', gap: 6 }}>
                        <select value={assocId} onChange={e => setAssocId(Number(e.target.value))} disabled={!can}>
                          <option value={0}>{tr('— not linked —')}</option>
                          {assoc.data?.map(a => <option key={a.id} value={a.id}>{a.name} ({a.chapters})</option>)}
                        </select>
                        {can && <span style={{ display: 'flex', gap: 6 }}><input value={newAssoc} onChange={e => setNewAssoc(e.target.value)} placeholder={tr('New link group…')} maxLength={200}
                          style={{ flex: 1, padding: '6px 10px', border: '1px solid #d0d5dd', borderRadius: 10, font: 'inherit' }} />
                          <button className="btn-ghost" onClick={addAssoc} disabled={busy || !newAssoc.trim()}>{tr('Add')}</button></span>}
                        <small className="mh">{tr('Chapters of different standards with the same link group belong together.')}</small>
                      </span>
                    </div>)}
                  {typeof sel === 'number' && cur?.untranslated && <small className="mh">{tr('Not translated into')}{' '}{lang} {tr('yet: the text starts with a language marker. Replace it and save to translate.')}</small>}
                </div>
                <div className="fm-btns">
                  {isRoot && <button className="btn-ghost" onClick={() => setMandDlg(true)} disabled={busy}>{tr('Mandatory Standards')}</button>}
                  <button className="btn-primary" onClick={save} disabled={busy || !can}>{busy ? <Spinner /> : tr('Save')}</button>
                  {typeof sel === 'number' && cur && <button className="btn-ghost" onClick={() => startNew(cur.id)} disabled={busy || !can}>{tr('Add chapter')}</button>}
                  {typeof sel === 'number' && cur && <button className="btn-ghost" onClick={() => setAskDel(cur)} disabled={busy || !can}>{tr('Remove')}</button>}
                  <button className="btn-ghost" onClick={() => nav('/documents')}>{tr('Close')}</button>
                </div>
              </div>
            </fieldset>)}
          {cur && <small className="mh">{cur.documents} {tr('document(s) are linked to this node. A node can be removed even when it has documents, as long as they are also linked to another node (manual p. 157). Changes apply to all languages.')}</small>}
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={ctxItems(menu.node)} onPick={k => pick(k, menu.node)} onClose={() => setMenu(null)} />}
      {askDel && <ConfirmDialog danger title={tr('Remove standard?')} confirmLabel={tr('Remove')} busy={busy}
        message={<><b>{askDel.name}</b>{(kids.get(askDel.id)?.length ?? 0) > 0 && <> {tr('and its')}{' '}{kids.get(askDel.id)!.length} {tr('chapter(s)')}</>} {tr('will be removed in all languages. Documents that are linked only to this node block the removal.')}</>}
        onConfirm={() => remove(askDel)} onCancel={() => setAskDel(null)} />}
      {imp && <ImportDialog lang={lang} onClose={() => setImp(false)} onDone={async (m) => { setImp(false); await refresh(); setMsg({ ok: true, t: m }); }} />}
      {mandDlg && <MandatoryDialog roots={roots} can={can} onClose={() => setMandDlg(false)} onDone={async n => { setMandDlg(false); await refresh(); setMsg({ ok: true, t: tr('{0} mandatory standard(s) saved.', n) }); }} />}
      <Toast msg={msg} onClose={() => setMsg(null)} />
    </div>
  );
}

function ImportDialog({ lang, onClose, onDone }: { lang: string; onClose: () => void; onDone: (m: string) => void }) {
  const [name, setName] = useState(''); const [short, setShort] = useState('');
  const [rows, setRows] = useState<ReturnType<typeof parseChapters>>([]);
  const [xl, setXl] = useState<File | null>(null); const [info, setInfo] = useState<StdXlsxInfo | null>(null);
  const [file, setFile] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [busy, onClose]);
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return;
    setErr(''); setFile(f.name); setRows([]); setInfo(null); setXl(null);
    if (/\.xlsx$/i.test(f.name)) {   // the Excel template: one sheet per language (Standard_EN, Standard_DE, ...)
      setBusy(true);
      try { const i = await api.importStandardXlsx(f, false, lang); setInfo(i); setXl(f); if (i.duplicate) setErr(tr('A standard with this name already exists.')); }
      catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
      return;
    }
    if (/\.xls$/i.test(f.name)) { setErr(tr('Old .xls files are not supported. Save the sheet as .xlsx (the template) or as CSV.')); return; }
    const r = parseChapters(await f.text()); setRows(r);
    if (!r.length) setErr(tr('No chapters found. The file needs the columns: Chapter No, Name, Description.'));
    if (!name) setName(f.name.replace(/\.[^.]+$/, ''));
  }
  async function go() {
    setBusy(true); setErr('');
    try {
      if (xl) { const r = await api.importStandardXlsx(xl, true, lang); onDone(tr('Standard imported with {0} chapter(s) in {1}.', r.chapters, r.languages.join(', '))); }
      else { const r = await api.importStandard({ lang, name: name.trim(), shortName: short.trim(), rows }); onDone(tr('Standard imported with {0} chapter(s).', r.chapters)); }
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  return (
    <div className="modal-back" onMouseDown={() => !busy && onClose()}>
      <div className="modal grp-dlg" style={{ width: 600 }} role="dialog" aria-modal="true" aria-label={tr('Import standard')} onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head"><div><h3 style={{ margin: 0 }}>{tr('Import standard')}</h3><div className="mh">{tr('Excel template (.xlsx, one sheet per language) or CSV')}</div></div><button className="x" onClick={onClose} disabled={busy} aria-label={tr('Close')}>✕</button></div>
        <div style={{ display: 'grid', gap: 10, padding: '4px 2px' }}>
          <div><input type="file" accept=".xlsx,.csv,.txt,.tsv" onChange={onFile} disabled={busy} /> {file && <small className="mh">{file}</small>}</div>
          {busy && <div><Spinner /> {tr('Reading…')}</div>}
          {info && (
            <div className="fm-ok">
              <b>{info.name}</b> — {info.chapters} {tr('chapter(s)')}<br />
              {tr('Languages in the file:')}{' '}{info.languages.join(', ')}.
              {info.missing.length > 0 && <> {info.missing.join(', ')} {tr('have no sheet: their text is taken from the first sheet and marked until translated.')}</>}
              {info.ignored.length > 0 && <> {tr('Sheets of inactive languages (')}{info.ignored.join(', ')}{tr(') are skipped.')}</>}
            </div>)}
          {!info && (<>
            <label className="fm-row" style={{ gridTemplateColumns: '120px 1fr' }}>{tr('Standard name')}<input value={name} maxLength={240} onChange={e => setName(e.target.value)} /></label>
            <label className="fm-row" style={{ gridTemplateColumns: '120px 1fr' }}>{tr('Short name')}<input value={short} maxLength={5} onChange={e => setShort(e.target.value)} /></label>
          </>)}
          {rows.length > 0 && (
            <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 10 }}>
              <table className="tbl" style={{ width: '100%', fontSize: 13 }}><thead><tr><th>{tr('No')}</th><th>{tr('Name')}</th></tr></thead>
                <tbody>{rows.slice(0, 200).map((r, i) => <tr key={i}><td>{r.chapterNo}</td><td>{r.name}</td></tr>)}</tbody></table>
            </div>)}
          {rows.length > 0 && <small className="mh">{rows.length} {tr('chapter(s). A chapter number such as 4.1.2 is placed below 4.1 (or 4), the others below the standard.')}</small>}
          {err && <div className="alert" role="alert">{err}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>{tr('Close')}</button>
          <button className="btn-primary" style={{ width: 'auto' }} onClick={go} disabled={busy || (info ? info.duplicate : (!name.trim() || rows.length === 0))}>{busy ? <Spinner /> : tr('Save')}</button>
        </div>
      </div>
    </div>
  );
}

/** "MS LDS-Mandatory Standards": pick the root standards documents must be linked to before release (manual p. 64). */
function MandatoryDialog({ roots, can, onClose, onDone }: { roots: StdNode[]; can: boolean; onClose: () => void; onDone: (n: number) => void }) {
  const [sel, setSel] = useState<Set<number>>(() => new Set(roots.filter(r => r.mandatory).map(r => r.id)));
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [busy, onClose]);
  const flip = (id: number) => setSel(o => { const s = new Set(o); if (s.has(id)) s.delete(id); else s.add(id); return s; });
  async function ok() {
    setBusy(true); setErr('');
    try { const r = await api.setMandatoryRoots([...sel]); onDone(r.mandatory); } catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  return (
    <div className="modal-back" onMouseDown={() => !busy && onClose()}>
      <div className="modal grp-dlg" style={{ width: 520 }} role="dialog" aria-modal="true" aria-label={tr('Mandatory standards')} onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head"><div><h3 style={{ margin: 0 }}>{tr('Mandatory Standards')}</h3><div className="mh">{tr('Documents must be linked to the selected standards before they are released')}</div></div><button className="x" onClick={onClose} disabled={busy} aria-label={tr('Close')}>✕</button></div>
        <div style={{ maxHeight: 340, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 10 }}>
          <table className="tbl" style={{ width: '100%' }}>
            <thead><tr><th style={{ width: 70 }}>{tr('Select')}</th><th>{tr('Name of Standard')}</th></tr></thead>
            <tbody>
              {roots.map(r => (
                <tr key={r.id} onClick={() => can && !busy && flip(r.id)} style={{ cursor: can ? 'pointer' : 'default' }}>
                  <td><input type="checkbox" checked={sel.has(r.id)} disabled={!can || busy} onChange={() => flip(r.id)} onClick={e => e.stopPropagation()} aria-label={tr('Mandatory: {0}', r.name)} /></td>
                  <td>{r.name}</td>
                </tr>))}
              {roots.length === 0 && <tr><td colSpan={2} className="mh">{tr('No standards yet.')}</td></tr>}
            </tbody>
          </table>
        </div>
        {err && <div className="alert" role="alert">{err}</div>}
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
          <button className="btn-primary" style={{ width: 'auto' }} onClick={ok} disabled={busy || !can}>{busy ? <Spinner /> : 'OK'}</button>
        </div>
      </div>
    </div>
  );
}
