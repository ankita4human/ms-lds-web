import { Fragment, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type CatchWord } from './api';
import { useLang } from './LangContext';
import { Spinner, PageLoader } from './components/Loader';
import ConfirmDialog from './components/ConfirmDialog';
import { IconCatch } from './components/Icons';
import PageHero from './components/PageHero';
import Toast from './components/Toast';
import { tr } from './i18n';

/** Options > Catch Management (manual p. 86-89): catchwords of the web search per language. Activate / deactivate (also several at once),
 *  edit the word, delete it, and switch single documents of a word on or off. */
export default function CatchManagement() {
  const { lang } = useLang();
  const qc = useQueryClient();
  const cfg = useQuery({ queryKey: ['catch-config'], queryFn: api.catchConfig });
  const can = cfg.data?.canManage ?? false;
  const [text, setText] = useState(''); const [q, setQ] = useState('');
  const [state, setState] = useState<'all' | 'active' | 'inactive'>('all');
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState<number[]>([]);
  const [last, setLast] = useState<number | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [edit, setEdit] = useState<CatchWord | null>(null);
  const [editText, setEditText] = useState('');
  const [askDel, setAskDel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);

  useEffect(() => { const t = setTimeout(() => { setQ(text.trim()); setPage(1); }, 350); return () => clearTimeout(t); }, [text]);
  useEffect(() => { setPage(1); setSel([]); setOpen(null); }, [lang, state]);
  const list = useQuery({ queryKey: ['catch', lang, q, state, page], queryFn: () => api.catchWords(lang, q, state, page), enabled: can && !!lang, placeholderData: p => p });
  const docs = useQuery({ queryKey: ['catch-docs', open], queryFn: () => api.catchDocs(open!), enabled: open !== null, gcTime: 0 });
  const items = list.data?.items ?? [];
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / (list.data?.pageSize ?? 100)));
  const refresh = () => qc.invalidateQueries({ queryKey: ['catch'] });

  async function run(fn: () => Promise<string>) { setBusy(true); try { const m = await fn(); await refresh(); setMsg({ ok: true, t: m }); } catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); } }
  const click = (e: React.MouseEvent, id: number) => {
    if (e.shiftKey && last !== null) {
      const a = items.findIndex(x => x.id === last), b = items.findIndex(x => x.id === id);
      if (a >= 0 && b >= 0) { const [lo, hi] = a < b ? [a, b] : [b, a]; setSel(items.slice(lo, hi + 1).map(x => x.id)); return; }
    }
    if (e.ctrlKey || e.metaKey) setSel(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]); else setSel([id]);
    setLast(id);
  };
  const setActive = (active: boolean) => run(async () => { const r = await api.setCatchState(sel, active); return `${r.changed} catchword(s) ${active ? 'activated' : 'deactivated'}.`; });
  const remove = () => run(async () => { const r = await api.deleteCatch(sel); setSel([]); setOpen(null); setAskDel(false); return `${r.removed} catchword(s) deleted.`; });
  const saveEdit = () => run(async () => { await api.editCatch(edit!.id, editText.trim()); setEdit(null); return tr('Catchword changed.'); });
  const toggleDoc = (idCatch: number, idDoc: number, active: boolean) => run(async () => {
    await api.setCatchDocState([{ idDoc, idCatch, active }]); await qc.invalidateQueries({ queryKey: ['catch-docs', idCatch] }); return active ? tr('Activated for the document.') : tr('Deactivated for the document.');
  });

  if (cfg.isLoading) return <PageLoader label={tr('Loading')} />;
  if (!cfg.data?.enabled) return <div className="um"><div className="card" style={{ padding: 20 }}>{tr('Catchwords are switched off (Config')}{' '}<b>{tr('IsCatchWordEnabled')}</b>).</div></div>;
  if (!can) return <div className="um"><div className="card" style={{ padding: 20 }}>{tr('You need the')}{' '}<b>{tr('Catch Management')}</b> {tr('right to open this page.')}</div></div>;

  return (
    <div className="um">
      <PageHero icon={<IconCatch />} title={tr('Catch management')} sub={tr('Catchwords for the document search on the web ({0})', lang)}
        chips={[{ n: list.data?.all ?? '–', label: 'catchwords' }, { n: list.data?.active ?? '–', label: 'active' }]} />
      <div className="card" style={{ padding: 16 }}>
        <div className="catch-bar">
          <input className="catch-search" value={text} onChange={e => setText(e.target.value)} placeholder={tr('Search catchwords…')} aria-label={tr('Search catchwords')} />
          <select value={state} onChange={e => setState(e.target.value as 'all' | 'active' | 'inactive')} aria-label={tr('Status filter')}>
            <option value="all">{tr('All')}</option><option value="active">{tr('Active')}</option><option value="inactive">{tr('Inactive')}</option></select>
          <span className="catch-actions">
            <button className="btn-ghost" onClick={() => setActive(true)} disabled={busy || sel.length === 0}>{tr('Activate')}</button>
            <button className="btn-ghost" onClick={() => setActive(false)} disabled={busy || sel.length === 0}>{tr('Deactivate')}</button>
            <button className="btn-ghost" onClick={() => { const w = items.find(x => x.id === sel[0]); if (w) { setEdit(w); setEditText(w.word); } }} disabled={busy || sel.length !== 1}>{tr('Edit')}</button>
            <button className="btn-ghost" onClick={() => setAskDel(true)} disabled={busy || sel.length === 0}>{tr('Delete')}</button>
          </span>
        </div>
        <small className="mh">{tr('Ctrl / Shift + click selects several words. A new word is added on the Catch tab of a document; words must have at least')}{' '}{cfg.data.minLen} {tr('characters.')}</small>
        {list.isLoading && <PageLoader compact label={tr('Loading catchwords')} />}
        {list.error && <div className="alert">{(list.error as Error).message}</div>}
        {list.data && items.length === 0 && <div className="mh" style={{ padding: 12 }}>{tr('No catchwords found.')}</div>}
        {items.length > 0 && (
          <table className="grid-table catch-tbl"><thead><tr><th style={{ width: 30 }} /><th>{tr('Catchword')}</th><th>{tr('Status')}</th><th>{tr('Documents')}</th></tr></thead>
            <tbody>{items.map(w => (<Fragment key={w.id}>
              <tr className={sel.includes(w.id) ? 'sel' : ''} onClick={e => click(e, w.id)}>
                <td><button className="dist-x" style={{ marginLeft: 0 }} aria-label={tr('Show documents')} title={tr('Show the documents of this word')} onClick={e => { e.stopPropagation(); setOpen(o => o === w.id ? null : w.id); }}>{open === w.id ? '▾' : '▸'}</button></td>
                <td>{w.word}</td><td>{w.active ? <span className="catch-on">{tr('● Active')}</span> : <span className="catch-off">{tr('○ Inactive')}</span>}</td><td>{w.documents}</td></tr>
              {open === w.id && (
                <tr><td /><td colSpan={3}>
                  {docs.isLoading && <Spinner />}
                  {docs.data && docs.data.items.length === 0 && <span className="mh">{tr('No document uses this catchword.')}</span>}
                  {docs.data?.items.map(d => (
                    <label key={d.idDoc} className="fm-chk" style={{ padding: '2px 0' }}>
                      <input type="checkbox" checked={d.active} disabled={busy} onChange={e => toggleDoc(w.id, d.idDoc, e.target.checked)} />
                      <span>#{d.idDoc} {d.name} <small className="mh">({d.manual ? 'manual' : 'automatic'})</small></span></label>))}
                </td></tr>)}
            </Fragment>))}</tbody></table>
        )}
        {pages > 1 && (
          <div className="catch-pager">
            <button className="btn-ghost" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>{tr('‹ Previous')}</button>
            <span>{tr('Page')}{' '}{page} {tr('of')}{' '}{pages}</span>
            <button className="btn-ghost" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>{tr('Next ›')}</button>
          </div>)}
      </div>

      {edit && (
        <div className="modal-back" onMouseDown={() => !busy && setEdit(null)}>
          <div className="modal" role="dialog" aria-label={tr('Edit catchword')} onMouseDown={e => e.stopPropagation()}>
            <div className="modal-head"><h3>{tr('Edit catchword')}</h3><button className="x" onClick={() => setEdit(null)} aria-label={tr('Close')}>✕</button></div>
            <label className="mf">{tr('Catchword')}<input autoFocus value={editText} maxLength={30} onChange={e => setEditText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && editText.trim()) saveEdit(); }} /></label>
            <div className="modal-foot">
              <button className="btn-ghost" onClick={() => setEdit(null)} disabled={busy}>{tr('Cancel')}</button>
              <button className="btn-primary" onClick={saveEdit} disabled={busy || !editText.trim() || editText.trim() === edit.word}>{busy ? <Spinner /> : tr('Save')}</button>
            </div>
          </div>
        </div>)}
      {askDel && <ConfirmDialog danger title={tr('Delete catchwords?')} confirmLabel={tr('Delete')} busy={busy}
        message={<>{sel.length} {tr('catchword(s) will be deleted together with their links to documents.')}</>} onConfirm={remove} onCancel={() => setAskDel(false)} />}
      <Toast msg={msg} onClose={() => setMsg(null)} />
    </div>
  );
}
