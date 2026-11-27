import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, downloadDocFile, previewDocFile } from '../api';
import { ACTION_LABEL, clearActivity, setFolder, track, useActivity, type ActEntry, type DocAction } from '../activity';
import { StatusBadge, ExtBadge } from './bits';
import { tr } from '../i18n';

const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function ago(t: number) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 45 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`;
}
const EXT_HUE: Record<string, number> = { pdf: 0, doc: 215, docx: 215, xls: 140, xlsx: 140, ppt: 25, pptx: 25, txt: 220, png: 280, jpg: 280, jpeg: 280 };
const extHue = (e: string) => EXT_HUE[e] ?? 200;

/** Floating "My activity" tray, left of the assistant button: documents the user viewed, downloaded, edited or verified in this login. */
export default function ActivityTray() {
  const items = useActivity();
  const [open, setOpen] = useState(false);
  const [ask, setAsk] = useState<ActEntry | null>(null);
  const [err, setErr] = useState('');
  const [, tick] = useState(0);
  const nav = useNavigate(); const loc = useLocation(); const qc = useQueryClient();
  const solo = loc.pathname.startsWith('/assistant');   // the assistant button is hidden on its own page

  // fill in folder and current status of the documents in the list (cached, one request per document)
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => tick(n => n + 1), 30_000);
    items.slice(0, 15).forEach(e => {
      qc.fetchQuery({ queryKey: ['doc-deep', e.idDoc, e.lang], queryFn: () => api.document(e.idDoc, e.lang), staleTime: 60_000 })
        .then(d => setFolder(e.idDoc, e.lang, d.paths?.[0] ?? '', d.doc.status ?? undefined, d.doc.statusName ?? undefined), () => { /* no access or removed: keep what we know */ });
    });
    return () => clearInterval(t);
  }, [open, items.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!open) return; const f = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { if (ask) setAsk(null); else setOpen(false); } }; window.addEventListener('keydown', f); return () => window.removeEventListener('keydown', f); }, [open, ask]);
  useEffect(() => { const f = () => setOpen(false); window.addEventListener('pl-auth', f); return () => window.removeEventListener('pl-auth', f); }, []);

  const counts = useMemo(() => {
    const m: Partial<Record<DocAction, number>> = {};
    items.forEach(e => e.events.forEach(v => { m[v.a] = (m[v.a] ?? 0) + 1; }));
    return m;
  }, [items]);

  function land(e: ActEntry, act?: string) {
    setAsk(null); setOpen(false);
    nav(`/documents?doc=${e.idDoc}${act ? `&act=${act}` : ''}`);
  }
  function click(e: ActEntry) {
    const before = e.events.some(v => v.a === 'download' || v.a === 'edit' || v.a === 'view');
    if (before) setAsk(ask && ask.idDoc === e.idDoc && ask.lang === e.lang ? null : e); else land(e);
  }
  async function again(e: ActEntry, what: 'download' | 'view' | 'edit') {
    setErr('');
    try {
      if (what === 'edit') { land(e, 'edit'); return; }
      if (what === 'view') { const p = previewDocFile(e.idDoc, e.lang); track('view', { idDoc: e.idDoc }, e.lang); await p; }
      else { await downloadDocFile(e.idDoc, e.lang, `${e.name}${e.ext ? '.' + e.ext : ''}`); track('download', { idDoc: e.idDoc }, e.lang); }
      setAsk(null);
    } catch (x) { setErr((x as Error).message); }
  }

  return (
    <>
      <button className={`act-fab ${solo ? 'solo' : ''} ${open ? 'open' : ''}`} onClick={() => { setOpen(o => !o); setAsk(null); setErr(''); }}
        aria-label={tr('My document activity')} title={tr('Documents I viewed, downloaded, edited or verified in this session')}>
        <span aria-hidden>🕘</span><span className="act-fab-text">{tr('Activity Pulse')}</span>
        {items.length > 0 && <i className="act-count">{items.length > 99 ? '99+' : items.length}</i>}
      </button>
      {open && (
        <div className={`act-panel ${solo ? 'solo' : ''}`} role="dialog" aria-label={tr('My document activity')}>
          <div className="act-head">
            <div><b>{tr('Activity Pulse')}</b><small>{tr('This login session ·')}{' '}{items.length} {tr('document')}{items.length === 1 ? '' : 's'}</small></div>
            <button className="act-clear" onClick={() => { clearActivity(); setAsk(null); }} disabled={items.length === 0}>{tr('Clear')}</button>
            <button className="act-x" onClick={() => setOpen(false)} aria-label={tr('Close')}>✕</button>
          </div>
          {items.length > 0 && (
            <div className="act-sum">{(Object.keys(ACTION_LABEL) as DocAction[]).filter(a => counts[a]).map(a =>
              <span key={a} title={ACTION_LABEL[a].past}>{ACTION_LABEL[a].icon} {counts[a]}</span>)}</div>)}
          <div className="act-list">
            {items.length === 0 && <div className="act-empty"><span>🗂️</span><b>{tr('Nothing yet')}</b><small>{tr('Documents you view, download, edit or verify appear here, so you can jump back to them.')}</small></div>}
            {items.map(e => {
              const key = `${e.idDoc}:${e.lang}`; const isAsk = ask?.idDoc === e.idDoc && ask.lang === e.lang;
              const agg = (Object.keys(ACTION_LABEL) as DocAction[]).map(a => ({ a, n: e.events.filter(v => v.a === a).length, at: [...e.events].reverse().find(v => v.a === a)?.at ?? 0 })).filter(x => x.n > 0).sort((x, y) => y.at - x.at);
              const dl = agg.find(x => x.a === 'download'), ed = agg.find(x => x.a === 'edit'), vw = agg.find(x => x.a === 'view');
              return (
                <div key={key} className={`act-item ${isAsk ? 'ask' : ''}`}>
                  <button className="act-row" onClick={() => click(e)}>
                    <span className="act-fi"><ExtBadge ext={e.ext} stacked compact /></span>
                    <span className="act-main">
                      <b title={e.name}>{e.name}</b>
                      <small className="act-folder" title={e.folder}>📁 {e.folder ? e.folder.split(' / ').map((p, i, a) => <span key={i}>{p}{i < a.length - 1 && <em> › </em>}</span>) : <i>#{e.idDoc} · {e.lang}</i>}</small>
                      <span className="act-chips">
                        {e.statusName && <StatusBadge id={e.status} name={e.statusName} />}
                        {agg.map(x => <span key={x.a} className={`act-chip a-${x.a}`} title={tr('{0} {1}×, last at {2}', ACTION_LABEL[x.a].past, x.n, hhmm(x.at))}>{ACTION_LABEL[x.a].icon} {ACTION_LABEL[x.a].past} {hhmm(x.at)}{x.n > 1 ? ` ×${x.n}` : ''}</span>)}
                      </span>
                    </span>
                    <span className="act-time">{ago(e.last)}</span>
                  </button>
                  {isAsk && (
                    <div className="act-ask">
                      <p>{dl ? <>{tr('You downloaded this at')}{' '}<b>{hhmm(dl.at)}</b>.</> : ed ? <>{tr('You edited this at')}{' '}<b>{hhmm(ed.at)}</b>.</> : <>{tr('You viewed this at')}{' '}<b>{hhmm(vw!.at)}</b>.</>} {tr('What do you want to do now?')}</p>
                      <div className="act-btns">
                        <button onClick={() => void again(e, 'download')}>{tr('⬇️ Download again')}</button>
                        <button onClick={() => void again(e, 'edit')}>{tr('✏️ Edit again')}</button>
                        <button onClick={() => void again(e, 'view')}>{tr('👁 View again')}</button>
                        <button className="pri" onClick={() => land(e)}>{tr('📂 Just show it in the folder')}</button>
                      </div>
                    </div>)}
                </div>);
            })}
          </div>
          {err && <div className="act-err" role="alert">{err}</div>}
        </div>
      )}
    </>
  );
}
