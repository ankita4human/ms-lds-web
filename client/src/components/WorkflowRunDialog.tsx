import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type WfCycle, type WfHistoryItem, type WfStep } from '../api';
import { Spinner, PageLoader } from './Loader';
import ConfirmDialog from './ConfirmDialog';

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + Math.max(0, n)); return iso(d); };
const fmt = (s?: string) => (s ? new Date(s).toLocaleDateString('en-GB') : '');
const fmtT = (s?: string) => (s ? new Date(s).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '');

const LAYER_ICO: Record<number, string> = { 1: '✏️', 2: '🔍', 3: '✅', 4: '🌐' };
type Hand = { moveId: number; editorId: number; due: string; remark: string };

/** Choose next step, editor, due date and remark (manual p. 69-71: the hand-over of a document to the next processing step). */
function HandOver({ steps, value, onChange, remarkLabel = 'Remark for the editor', allowSteps = true }: {
  steps: WfStep[]; value: Hand; onChange: (h: Hand) => void; remarkLabel?: string; allowSteps?: boolean;
}) {
  const step = steps.find(s => s.id === value.moveId);
  const pickStep = (id: number) => {
    const s = steps.find(x => x.id === id);
    const ed = s?.candidates.some(c => c.id === s.editor) ? s.editor : s?.candidates[0]?.id ?? 0;
    onChange({ ...value, moveId: id, editorId: ed, due: addDays(s?.days ?? 0) });
  };
  return (
    <div className="wf-form">
      <div className="wfd-lab">{allowSteps ? 'Step' : 'Next step'}</div>
      <div className="wfd-steps" role="radiogroup" aria-label="Step">
        {steps.map((x, i) => (
          <button type="button" key={x.id} role="radio" aria-checked={x.id === value.moveId} disabled={!allowSteps}
            className={`wfd-step l${x.layer} ${x.id === value.moveId ? 'on' : ''}`} onClick={() => pickStep(x.id)}>
            <span className="wfd-n">{i + 1}</span><span className="wfd-ico" aria-hidden="true">{LAYER_ICO[x.layer] ?? '•'}</span>
            <b>{x.name}</b><small>{x.layerName} · {x.days} day(s)</small></button>))}
      </div>
      {step?.description && <small className="mh">{step.description}</small>}
      <label>Editor
        <select value={value.editorId} onChange={e => onChange({ ...value, editorId: Number(e.target.value) })}>
          {step?.candidates.length === 0 && <option value={0}>– nobody can take this step –</option>}
          {step?.candidates.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select></label>
      <label>Complete by
        <input type="date" min={iso(new Date())} value={value.due} onChange={e => onChange({ ...value, due: e.target.value })} /></label>
      <label>{remarkLabel}
        <textarea rows={3} maxLength={1000} value={value.remark} onChange={e => onChange({ ...value, remark: e.target.value })} /></label>
    </div>
  );
}

function HistoryTable({ items }: { items: WfHistoryItem[] }) {
  if (items.length === 0) return <div className="mh">No entries.</div>;
  return (
    <div style={{ overflow: 'auto' }}>
      <table className="tbl"><thead><tr><th>Step</th><th>Type</th><th>Editor</th><th>Assigned by</th><th>Assigned</th><th>Due</th><th>Finished</th><th>Result</th><th>Remark</th></tr></thead>
        <tbody>{items.map(h => (
          <tr key={h.taskId}><td>{h.step}</td><td>{h.layerName}</td><td>{h.assignee}</td><td>{h.assignedBy}</td><td>{fmtT(h.assigned)}</td><td>{fmt(h.due)}</td><td>{fmtT(h.finished)}</td>
            <td className={`wf-out-${h.outcome}`}>{h.outcome === 'done' ? '👍 Done' : h.outcome === 'returned' ? '👎 Returned' : '⏳ Open'}</td><td style={{ whiteSpace: 'pre-wrap' }}>{h.remark}</td></tr>))}</tbody></table>
    </div>
  );
}

/** Document menu > Workflow (manual p. 67-72). Not in a workflow: start one. In a workflow: show the process, accept (thumbs up) or reject (thumbs down), remove. */
export default function WorkflowRunDialog({ doc, lang, onClose, onDone }: {
  doc: { idDoc: number; docName: string }; lang: string; onClose: () => void; onDone: (msg: string) => void;
}) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['wf-state', doc.idDoc, lang], queryFn: () => api.wfState(doc.idDoc, lang), gcTime: 0, staleTime: 0, retry: false });
  const s = q.data;
  const [tab, setTab] = useState<'step' | 'history'>('step');
  const hist = useQuery({ queryKey: ['wf-hist', doc.idDoc, lang], queryFn: () => api.wfHistory(doc.idDoc, lang), enabled: tab === 'history', gcTime: 0 });
  const [cycleId, setCycleId] = useState(0);
  const [hand, setHand] = useState<Hand>({ moveId: 0, editorId: 0, due: addDays(0), remark: '' });
  const [mode, setMode] = useState<'accept' | 'reject'>('accept');
  const [reason, setReason] = useState('');
  const [pwd, setPwd] = useState('');
  const wfo = useQuery({ queryKey: ['wf-options-rel'], queryFn: () => api.workflowOptions(), staleTime: 60000 });
  const [askRemove, setAskRemove] = useState(false);
  const [removeReason, setRemoveReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const [fType, setFType] = useState(0); const [fGrp, setFGrp] = useState(0); const [fFolder, setFFolder] = useState(0);
  const allCycles: WfCycle[] = s && !s.inWorkflow ? s.cycles : [];
  const filters = s && !s.inWorkflow ? s.filters : { docTypes: [], userGroups: [], groups: [] };
  // manual p. 120-122: the list of workflows can be filtered by document type, user group and folder (a workflow without a restriction fits every value)
  const cycles = allCycles.filter(c => (!fType || c.docTypes.length === 0 || c.docTypes.includes(fType)) && (!fGrp || c.userGroups.length === 0 || c.userGroups.includes(fGrp))
    && (!fFolder || c.groups.length === 0 || c.groups.includes(fFolder)));
  const cycle = cycles.find(c => c.id === cycleId);
  const filtered = fType !== 0 || fGrp !== 0 || fFolder !== 0;
  useEffect(() => { if (!cycle && cycles[0]) chooseCycle(cycles[0]); }, [fType, fGrp, fFolder]); // eslint-disable-line react-hooks/exhaustive-deps

  const initHand = (steps: WfStep[], moveId: number): Hand => {
    const st = steps.find(x => x.id === moveId) ?? steps[0];
    const ed = st?.candidates.some(c => c.id === st.editor) ? st.editor : st?.candidates[0]?.id ?? 0;
    return { moveId: st?.id ?? 0, editorId: ed, due: addDays(st?.days ?? 0), remark: '' };
  };
  // when the state arrives: preselect the first workflow, or the default next step of the running one
  useEffect(() => {
    if (!s) return;
    if (!s.inWorkflow) {
      const c = s.cycles[0]; if (c) { setCycleId(c.id); setHand(initHand(c.steps, c.nextDefault)); }
    } else {
      setHand(initHand(s.steps, s.next.nextDefault));
      setMode(s.current && s.canAct ? 'accept' : 'accept');
    }
  }, [s]); // eslint-disable-line react-hooks/exhaustive-deps

  const chooseCycle = (c: WfCycle) => { setCycleId(c.id); setHand(initHand(c.steps, c.nextDefault)); };
  const refresh = () => Promise.all(['docs', 'doc', 'doc-deep', 'wf-tasks', 'wf-summary'].map(k => qc.invalidateQueries({ queryKey: [k] })));

  async function run(fn: () => Promise<string>) {
    setBusy(true); setErr('');
    try { const m = await fn(); await refresh(); onDone(m); } catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  const startIt = () => run(async () => {
    const r = await api.wfStart(doc.idDoc, { lang, cycleId, nextMoveId: hand.moveId, editorId: hand.editorId, due: hand.due, remark: hand.remark.trim() });
    return `The document was added to the workflow "${cycle?.name}". ${r.mail}`.trim();
  });
  const advance = () => run(async () => {
    if (!s || !s.inWorkflow || !s.current) return '';
    if (mode === 'accept') {
      // Release / Publish steps do the real action first (the same code as the Document menu), then the workflow moves on.
      const layer = s.current.layer, st = s.doc.status;
      let extra = '';
      if (layer === 3 || layer === 4) {
        if (st === 1 || st === 2) await api.verifyDoc(doc.idDoc, lang);
        const needPwd = !!wfo.data?.validateOnRelease;
        if (layer === 3 && st !== 8 && st !== 3) { if (needPwd && !pwd) throw new Error('Please enter your password to release the document.'); await api.releaseDoc(doc.idDoc, lang, needPwd ? pwd : undefined, undefined, true); extra = ' The document was released.'; }
        if (layer === 4) {
          if (st === 1 || st === 2 || st === 7) { if (needPwd && !pwd) throw new Error('Please enter your password to release the document.'); await api.releasePublishDoc(doc.idDoc, lang, needPwd ? pwd : undefined, undefined, undefined, true); extra = ' The document was released and queued for publishing.'; }
          else if (st === 8) { await api.publishDoc(doc.idDoc, lang, undefined, true); extra = ' The document was queued for publishing.'; }
        }
      }
      const r = await api.wfAdvance(doc.idDoc, { lang, taskId: s.current.taskId, action: 'accept', nextMoveId: s.current.isLast ? 0 : hand.moveId, editorId: s.current.isLast ? 0 : hand.editorId, due: s.current.isLast ? null : hand.due, remark: hand.remark.trim() });
      return (r.finished ? 'The workflow is completed.' : `The document was handed over. ${r.mail}`.trim()) + extra;
    }
    if (!reason.trim()) throw new Error('Please give a reason: the previous user sees it as the remark.');
    const p = s.previous;
    const r = await api.wfAdvance(doc.idDoc, { lang, taskId: s.current.taskId, action: 'reject', nextMoveId: p?.moveId ?? 0, editorId: p?.editorId ?? 0, due: null, remark: reason.trim() });
    return `The document was handed back. ${r.mail}`.trim();
  });
  const removeIt = () => run(async () => { await api.wfRemove(doc.idDoc, lang, removeReason.trim()); return 'The document was removed from the workflow.'; });

  const flow = useMemo(() => {
    if (!s) return [] as { name: string; cls: string }[];
    if (!s.inWorkflow) return (cycle?.steps ?? []).map(x => ({ name: x.name, cls: '' }));
    const done = new Set(s.history.items.filter(h => h.outcome !== 'open').map(h => h.step));
    return s.steps.map(x => ({ name: x.name, cls: s.current?.step === x.name ? 'cur' : done.has(x.name) ? 'done' : '' }));
  }, [s, cycle]);

  const hint = s && s.inWorkflow && s.current && s.current.expectedStatus !== s.doc.status
    ? `This is a "${s.current.layerName}" step. The status follows the workflow: accepting a Verify, Release or Publish step verifies, releases or publishes the document.` : '';

  return (
    <div className="modal-back" onMouseDown={() => !busy && onClose()}>
      <div className="modal wf-dlg wfd" role="dialog" aria-label="Workflow" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head"><h3>Workflow</h3><button className="x" onClick={onClose} disabled={busy} aria-label="Close">✕</button></div>
        <div className="wfd-banner"><span className="wfd-banner-ico" aria-hidden="true">🔀</span><div><b>#{doc.idDoc} {doc.docName}</b>{s && <small>Version {s.doc.version} · {lang}{s.inWorkflow ? ' · in workflow' : ' · not in a workflow'}</small>}</div></div>
        {s?.inWorkflow && <div className="wf-tabs"><button className={tab === 'step' ? 'on' : ''} onClick={() => setTab('step')}>Process step</button><button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>History</button></div>}

        <div className="wf-body">
          {q.isLoading && <PageLoader compact label="Loading workflow" />}
          {q.error && <div className="alert" role="alert">{(q.error as Error).message}</div>}

          {s && !s.inWorkflow && (<>
            {!s.canStart && <div className="alert">A blocked, frozen or archived document cannot be added to a workflow.</div>}
            {s.canStart && allCycles.length === 0 && <div className="wf-hint">No active workflow is available for this document: check the document type, folder and your user group of the workflows (Options &gt; Workflow management).</div>}
            {s.canStart && allCycles.length > 0 && (<>
              <div className="wfd-h"><span className="wfd-hn">1</span><b>Choose the workflow</b></div>
              {(filters.docTypes.length > 0 || filters.userGroups.length > 0 || filters.groups.length > 0) && (
                <div className="wf-filter">
                  <label>Document type<select value={fType} onChange={e => setFType(Number(e.target.value))}><option value={0}>All</option>{filters.docTypes.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
                  <label>User group<select value={fGrp} onChange={e => setFGrp(Number(e.target.value))}><option value={0}>All</option>{filters.userGroups.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
                  <label>Group<select value={fFolder} onChange={e => setFFolder(Number(e.target.value))}><option value={0}>All</option>{filters.groups.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
                </div>)}
              {cycles.length === 0 && <div className="wf-hint">{filtered ? 'No workflow matches the selected filter.' : 'No workflow available.'}</div>}
              <div className="wfd-cards" role="radiogroup" aria-label="Workflow">{cycles.map(c => (
                <button type="button" role="radio" aria-checked={c.id === cycleId} key={c.id} className={`wfd-card ${c.id === cycleId ? 'on' : ''}`} onClick={() => chooseCycle(c)}>
                  <span className="wfd-check" aria-hidden="true">{c.id === cycleId ? '✓' : ''}</span>
                  <b>{c.name}</b>
                  {c.description && <span className="wfd-desc">{c.description}</span>}
                  <span className="wfd-mini">{c.steps.map((x, i) => <span key={x.id} className={`wfd-dotp l${x.layer}`} title={`${i + 1}. ${x.name} (${x.layerName})`}>{LAYER_ICO[x.layer] ?? '•'}</span>)}</span>
                  <small>{c.steps.length} step(s)</small>
                </button>))}</div>
              <div className="wfd-h"><span className="wfd-hn">2</span><b>Choose the step to start with</b></div>
              {cycle && <HandOver steps={cycle.steps} value={hand} onChange={setHand} />}
            </>)}
          </>)}

          {s?.inWorkflow && tab === 'step' && (<>
            <div><b>{s.cycle.name}</b>{s.cycle.description && <div className="mh">{s.cycle.description}</div>}</div>
            <div className="wf-flow">{flow.map((x, i) => <span key={i}>{i > 0 && '→ '}<span className={`wf-chip ${x.cls}`}>{x.name}</span></span>)}</div>
            {s.current ? (<>
              <div className="wf-kv">
                <b>Current step</b><span>{s.current.step} ({s.current.layerName})</span>
                <b>Editor</b><span>{s.current.assignee}</span>
                <b>Assigned by</b><span>{s.current.startedBy} · {fmtT(s.current.dateStart)}</span>
                <b>Complete by</b><span className={s.current.overdue ? 'overdue' : ''}>{fmt(s.current.due)}{s.current.overdue ? ' (overdue)' : ''}</span>
                {s.current.stepDescription && <><b>Step description</b><span>{s.current.stepDescription}</span></>}
                {s.current.remark && <><b>Remark</b><span style={{ whiteSpace: 'pre-wrap' }}>{s.current.remark}</span></>}
              </div>
              {hint && s.canAct && <div className="wf-hint">{hint}</div>}
              {!s.canAct && <div className="wf-hint">This task is assigned to {s.current.assignee}. Only the editor or a workflow administrator can accept or reject it.</div>}
              {s.canAct && (<>
                <div className="wf-pick">
                  <label className={mode === 'accept' ? 'on' : ''}><input type="radio" name="m" checked={mode === 'accept'} onChange={() => setMode('accept')} />
                    <span>👍 <b>{s.current.isLast ? 'Accept and finish the workflow' : 'Accept and hand over to the next step'}</b></span></label>
                  <label className={mode === 'reject' ? 'on' : ''}><input type="radio" name="m" checked={mode === 'reject'} onChange={() => setMode('reject')} disabled={!s.previous} />
                    <span>👎 <b>Reject and hand back{s.previous ? ` to ${s.previous.editor} (${s.previous.step})` : ''}</b></span></label>
                </div>
                {mode === 'accept' && (s.current.isLast
                  ? <label className="wf-form"><label>Remark (optional)<textarea rows={3} maxLength={1000} value={hand.remark} onChange={e => setHand({ ...hand, remark: e.target.value })} /></label></label>
                  : <HandOver steps={s.steps} value={hand} onChange={setHand} />)}
                {mode === 'accept' && (s.current.layer === 3 || s.current.layer === 4) && wfo.data?.validateOnRelease && s.doc.status !== 8 && s.doc.status !== 3 && <div className="wf-form"><label>Your password (needed to release)<input type="password" autoComplete="current-password" value={pwd} onChange={e => setPwd(e.target.value)} /></label></div>}
                {mode === 'reject' && <div className="wf-form"><label>Reason (required)<textarea rows={3} maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} /></label></div>}
              </>)}
            </>) : <div className="wf-hint">All steps are finished.</div>}
          </>)}

          {s?.inWorkflow && tab === 'history' && (<>
            <b>Current run</b><HistoryTable items={s.history.items} />
            {hist.isLoading && <PageLoader compact label="Loading history" />}
            {hist.data?.runs.filter(r => !r.current).map(r => (
              <div key={r.run}><b>Earlier run #{r.run}: {r.workflow}</b><HistoryTable items={r.data.items} /></div>))}
            {hist.data && hist.data.runs.filter(r => !r.current).length === 0 && <div className="mh">No earlier workflow runs.</div>}
          </>)}

          {err && <div className="alert" role="alert">{err}</div>}
        </div>

        <div className="modal-foot">
          {s?.inWorkflow && s.canRemove && <button className="btn-ghost" style={{ marginRight: 'auto' }} onClick={() => { setRemoveReason(''); setAskRemove(true); }} disabled={busy}>Remove from workflow</button>}
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Close</button>
          {s && !s.inWorkflow && s.canStart && cycle && <button className="btn-primary" onClick={startIt} disabled={busy || !cycleId || !hand.editorId}>{busy ? <><Spinner />Starting</> : 'Start workflow'}</button>}
          {s?.inWorkflow && s.current && s.canAct && tab === 'step' && <button className="btn-primary" onClick={advance} disabled={busy || (mode === 'accept' && !s.current.isLast && !hand.editorId)}>
            {busy ? <><Spinner />Saving</> : mode === 'accept' ? (s.current.isLast ? 'Finish' : 'Hand over') : 'Hand back'}</button>}
        </div>
      </div>
      {askRemove && (
        <ConfirmDialog danger title="Remove from workflow?" confirmLabel="Remove" busy={busy}
          message={<><div>The document leaves the workflow; the run is kept in the history.</div>
            <label className="wf-form" style={{ marginTop: 8 }}><label>Reason (optional)<input value={removeReason} maxLength={900} onChange={e => setRemoveReason(e.target.value)} /></label></label></>}
          onConfirm={async () => { await removeIt(); setAskRemove(false); }} onCancel={() => setAskRemove(false)} />
      )}
    </div>
  );
}

/** Document menu > Remove from workflow ("Workflow entfernen"): works at any stage of the workflow. */
export function RemoveFromWorkflowDialog({ doc, lang, onClose, onDone }: {
  doc: { idDoc: number; docName: string }; lang: string; onClose: () => void; onDone: (msg: string, ok: boolean) => void;
}) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      await api.wfRemove(doc.idDoc, lang, reason.trim());
      await Promise.all(['docs', 'doc', 'doc-deep', 'wf-tasks', 'wf-summary'].map(k => qc.invalidateQueries({ queryKey: [k] })));
      onDone('The document was removed from the workflow.', true);
    } catch (e) { onDone((e as Error).message, false); }
  }
  return (
    <ConfirmDialog danger title="Remove from workflow?" confirmLabel="Remove" busy={busy}
      message={<><div><b>#{doc.idDoc} {doc.docName}</b> leaves the workflow. The run is kept in the history.</div>
        <label className="wf-form" style={{ marginTop: 8 }}><label>Reason (optional)<input value={reason} maxLength={900} onChange={e => setReason(e.target.value)} /></label></label></>}
      onConfirm={go} onCancel={onClose} />
  );
}
