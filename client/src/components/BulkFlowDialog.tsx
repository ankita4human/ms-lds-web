import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type DocRow } from '../api';
import { Spinner } from './Loader';
import { track } from '../activity';
import { tr } from '../i18n';

/** Verify / Release / Publish for many documents at once. Every document goes through the same server calls as the single
 *  actions (so all legacy rules and rights are checked per document); a document that cannot take the step is skipped with the reason. */
export type BulkKind = 'verify' | 'release' | 'publish' | 'all';
type Step = 'verify' | 'release' | 'publish';
const RIGHT: Record<Step, number> = { verify: 18, release: 36, publish: 19 };

export function planFor(kind: BulkKind, d: DocRow, can: (right: number) => boolean): Step[] | string {
  const s = d.status;
  let steps: Step[] | null = null;
  if (kind === 'verify') steps = s === 1 || s === 2 ? ['verify'] : null;
  else if (kind === 'release') steps = s === 7 ? ['release'] : null;
  else if (kind === 'publish') steps = s === 8 || s === 3 ? ['publish'] : null;
  else steps = s === 1 || s === 2 ? ['verify', 'release', 'publish'] : s === 7 ? ['release', 'publish'] : s === 8 ? ['publish'] : null;
  if (!steps) {
    return kind === 'verify' ? tr('Not in Draft or Edit status') : kind === 'release' ? tr('Not verified') : kind === 'publish' ? tr('Not released')
      : s === 3 ? tr('Already published') : tr('Status does not allow it');
  }
  const miss = steps.find(x => !can(RIGHT[x]));
  return miss ? tr('No right to {0}', miss) : steps;
}

const TITLE: Record<BulkKind, { t: string; ic: string; go: string; text: string }> = {
  verify: { t: 'Verify documents', ic: '✅', go: 'Verify', text: 'Draft and Edit documents are approved as finished.' },
  release: { t: 'Release documents', ic: '🚀', go: 'Release', text: 'Verified documents are released. Other languages follow the original as for a single release.' },
  publish: { t: 'Publish documents', ic: '📣', go: 'Publish', text: 'Released documents are put in the publishing queue and published in the background.' },
  all: { t: 'Verify, release and publish', ic: '⚡', go: 'Run all steps', text: 'Each document goes as far as it can: Draft/Edit → verify → release → publish, Verified → release → publish, Released → publish.' },
};

type Row = { doc: DocRow; steps: Step[] | null; skip?: string; state: 'wait' | 'run' | 'ok' | 'err' | 'skip'; msg?: string };

export default function BulkFlowDialog({ kind, docs, lang, can, onClose, onFinished }: {
  kind: BulkKind; docs: DocRow[]; lang: string; can: (right: number) => boolean; onClose: () => void;
  onFinished: (s: { ok: number; failed: number; skipped: number; queued: number }) => void;
}) {
  const initial = useMemo<Row[]>(() => docs.map(d => {
    const p = planFor(kind, d, can);
    return typeof p === 'string' ? { doc: d, steps: null, skip: p, state: 'skip' as const, msg: p } : { doc: d, steps: p, state: 'wait' as const };
  }), [docs, kind, can]);
  const [rows, setRows] = useState<Row[]>(initial);
  const [phase, setPhase] = useState<'review' | 'run' | 'done'>('review');
  const [pwd, setPwd] = useState('');
  const stop = useRef(false);
  const todo = rows.filter(r => r.steps);
  const needRelease = todo.some(r => r.steps!.includes('release'));
  const opts = useQuery({ queryKey: ['wf-options'], queryFn: api.workflowOptions, enabled: needRelease });
  const needPwd = needRelease && !!opts.data?.validateOnRelease;
  const T = TITLE[kind];
  const counts = { ok: rows.filter(r => r.state === 'ok').length, failed: rows.filter(r => r.state === 'err').length, skipped: rows.filter(r => r.state === 'skip').length };
  const finished = counts.ok + counts.failed + counts.skipped;
  const patch = (i: number, p: Partial<Row>) => setRows(cur => cur.map((r, k) => (k === i ? { ...r, ...p } : r)));

  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && phase !== 'run') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [phase, onClose]);

  async function run() {
    stop.current = false; setPhase('run');
    let queued = 0, okN = 0, failN = 0; let abort = false;
    let skipN = rows.filter(r => !r.steps).length;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!; if (!r.steps) continue;
      if (stop.current || abort) { patch(i, { state: 'skip', msg: abort ? tr('Not run: password was not accepted') : tr('Stopped') }); skipN++; continue; }
      patch(i, { state: 'run', msg: undefined });
      const d = r.doc; const pw = needPwd ? pwd : undefined;
      try {
        const st = r.steps; let out = '';
        if (st.includes('verify')) { await api.verifyDoc(d.idDoc, lang); out = 'Verified'; }
        if (st.includes('release') && st.includes('publish')) { const x = await api.releasePublishDoc(d.idDoc, lang, pw, undefined, undefined, true); out = `${out ? out + ', ' : ''}released v${x.version}${x.mailSent ? ' (mail sent)' : ''}, queued for publishing`; queued++; }
        else if (st.includes('release')) { const x = await api.releaseDoc(d.idDoc, lang, pw, undefined, true); out = `${out ? out + ', ' : ''}released v${x.version}${x.mailSent ? ' (mail sent)' : x.mailError ? ' (mail failed)' : ''}`; }
        else if (st.includes('publish')) { await api.publishDoc(d.idDoc, lang, undefined, true); out = tr('Queued for publishing'); queued++; }
        st.forEach(x => track(x, d, lang));   // shows up in the "My activity" tray
        patch(i, { state: 'ok', msg: out }); okN++;
      } catch (e) {
        const m = (e as Error).message;
        patch(i, { state: 'err', msg: m }); failN++;
        if (needPwd && /password/i.test(m)) abort = true;
      }
    }
    setPhase('done');
    onFinished({ ok: okN, failed: failN, skipped: skipN, queued });
  }

  const icon = (s: Row['state']) => (s === 'run' ? <span className="nb-spin" /> : s === 'ok' ? '✓' : s === 'err' ? '!' : s === 'skip' ? '–' : '•');
  const pct = rows.length ? Math.round((finished / rows.length) * 100) : 0;

  return (
    <div className="modal-back" style={{ zIndex: 90 }} onMouseDown={() => phase !== 'run' && onClose()}>
      <div className="modal bk" role="dialog" aria-modal="true" aria-label={T.t} onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head"><h3><span aria-hidden="true">{T.ic}</span> {T.t}</h3><button className="x" onClick={onClose} disabled={phase === 'run'} aria-label={tr('Close')}>✕</button></div>
        <p className="bk-lead">{phase === 'review' ? <><b>{todo.length}</b> {tr('of')}{' '}{rows.length} {tr('selected document')}{rows.length === 1 ? '' : 's'} {tr('can take this step.')}{' '}{T.text}</> : phase === 'run' ? tr('Working through the documents - please keep this window open.') : tr('Finished.')}</p>

        {phase !== 'review' && <div className="up-progress"><span style={{ width: `${pct}%` }} /><em>{finished} {tr('of')}{' '}{rows.length}</em></div>}

        <div className="bk-list">
          {rows.map((r, i) => (
            <div key={r.doc.idDoc} className={`bk-row ${r.state}`}>
              <span className="bk-ic" aria-hidden="true">{icon(r.state)}</span>
              <div className="bk-tx">
                <b title={r.doc.docName}>{r.doc.docName}</b>
                <small>#{r.doc.idDoc} · {r.doc.statusName} {tr('· v')}{r.doc.v1}.{r.doc.v2}.{r.doc.v3}</small>
              </div>
              <span className="bk-res">
                {r.state === 'wait' && r.steps ? r.steps.map(s => s[0]!.toUpperCase() + s.slice(1)).join(' → ') : r.msg}
              </span>
              {phase === 'review' && !r.steps && <span className="bk-skip">{tr('skipped')}</span>}
              {phase === 'review' && r.steps && <button className="nb-x" aria-label={tr('Leave out')} title={tr('Leave out')} onClick={() => patch(i, { steps: null, state: 'skip', skip: tr('Left out'), msg: tr('Left out') })}>×</button>}
            </div>
          ))}
        </div>

        {phase === 'review' && needPwd && (
          <label className="wf-pwd">{tr('Confirm the release with your password')}<input type="password" value={pwd} autoComplete="current-password" onChange={e => setPwd(e.target.value)} /></label>
        )}
        {phase === 'done' && (
          <div className={`bk-sum ${counts.failed ? 'bad' : 'ok'}`} role="status">
            <b>{counts.ok}</b> {tr('done')}{counts.failed > 0 && <> · <b>{counts.failed}</b> {tr('failed')}</>}{counts.skipped > 0 && <> · <b>{counts.skipped}</b> {tr('skipped')}</>}
            {kind !== 'verify' && kind !== 'release' && counts.ok > 0 && <small> {tr('Publishing continues in the background - watch the bell.')}</small>}
          </div>
        )}

        <div className="modal-foot">
          {phase === 'review' && <><button className="btn-ghost" onClick={onClose}>{tr('Cancel')}</button>
            <button className="btn-primary" style={{ width: 'auto' }} disabled={!todo.length || (needPwd && !pwd) || (needRelease && opts.isLoading)} onClick={run}>{T.go} ({todo.length})</button></>}
          {phase === 'run' && <button className="btn-ghost" onClick={() => { stop.current = true; }}><Spinner /> {tr('Stop after this document')}</button>}
          {phase === 'done' && <button className="btn-primary" style={{ width: 'auto' }} onClick={onClose}>{tr('Close')}</button>}
        </div>
      </div>
    </div>
  );
}
