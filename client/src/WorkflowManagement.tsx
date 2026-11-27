import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, WfSaveBody, WfStepBody } from './api';
import { useLang } from './LangContext';
import { Spinner, PageLoader } from './components/Loader';
import ConfirmDialog from './components/ConfirmDialog';
import { IconFlow } from './components/Icons';
import PageHero from './components/PageHero';
import Toast from './components/Toast';
import { tr } from './i18n';

const emptyStep = (): WfStepBody => ({ id: 0, name: '', layer: 1, editor: 0, userGroup: 0, days: 1, description: '' });

/** Options > Workflow management (manual p. 67-72): workflows with their steps (Edit, Verify, Release, Publish), editor, user group,
 *  processing time, and the document types, user groups and folders a workflow is valid for. */
export default function WorkflowManagement() {
  const { lang } = useLang();
  const qc = useQueryClient();
  const nav = useNavigate();
  const cfg = useQuery({ queryKey: ['wf-config'], queryFn: api.wfConfig });
  const can = cfg.data?.canManage ?? false;
  const list = useQuery({ queryKey: ['workflows'], queryFn: api.workflows, enabled: can });
  const opts = useQuery({ queryKey: ['wf-options', lang], queryFn: () => api.wfOptions(lang), enabled: can && !!lang });

  const [selId, setSelId] = useState<number | 'new' | null>(null);
  const [name, setName] = useState(''); const [active, setActive] = useState(true); const [desc, setDesc] = useState('');
  const [types, setTypes] = useState<number[]>([]); const [ugs, setUgs] = useState<number[]>([]); const [grps, setGrps] = useState<number[]>([]);
  const [steps, setSteps] = useState<WfStepBody[]>([]);
  const [selStep, setSelStep] = useState(-1);
  const [dirty, setDirty] = useState(false);
  const [pendingSel, setPendingSel] = useState<number | 'new' | 'close' | null>(null);
  const [askDel, setAskDel] = useState(false);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);

  const touch = <T,>(set: (v: T) => void) => (v: T) => { set(v); setDirty(true); };

  async function load(id: number) {
    setBusy(true);
    try {
      const d = await api.wf(id);
      setName(d.name); setActive(d.active); setDesc(d.description); setTypes(d.docTypes); setUgs(d.userGroups); setGrps(d.groups);
      setSteps(d.steps); setSelStep(d.steps.length ? 0 : -1); setSelId(id); setDirty(false);
    } catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); }
  }
  function startNew() {
    setSelId('new'); setName(''); setActive(true); setDesc(''); setTypes([]); setUgs([]); setGrps([]);
    setSteps([emptyStep()]); setSelStep(0); setDirty(false);
  }
  function go(target: number | 'new' | 'close') {
    if (dirty && selId !== null) { setPendingSel(target); return; }
    doGo(target);
  }
  function doGo(target: number | 'new' | 'close') {
    setPendingSel(null);
    if (target === 'close') nav('/documents'); else if (target === 'new') startNew(); else load(target);
  }
  useEffect(() => {
    const k = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); };
    window.addEventListener('beforeunload', k); return () => window.removeEventListener('beforeunload', k);
  }, [dirty]);

  const step = steps[selStep];
  const patchStep = (p: Partial<WfStepBody>) => { setSteps(s => s.map((x, i) => i === selStep ? { ...x, ...p } : x)); setDirty(true); };
  const addStep = () => { setSteps(s => [...s, emptyStep()]); setSelStep(steps.length); setDirty(true); };
  const removeStep = () => {
    if (!step) return;
    if (step.inUse) { setMsg({ ok: false, t: tr('This step is used by running workflows and cannot be removed.') }); return; }
    setSteps(s => s.filter((_, i) => i !== selStep)); setSelStep(Math.max(0, selStep - 1)); setDirty(true);
  };
  const move = (dir: -1 | 1) => {
    const j = selStep + dir; if (j < 0 || j >= steps.length) return;
    setSteps(s => { const c = [...s]; [c[selStep], c[j]] = [c[j], c[selStep]]; return c; }); setSelStep(j); setDirty(true);
  };

  const toggle = (arr: number[], set: (v: number[]) => void, id: number) => { set(arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id]); setDirty(true); };
  const layerName = (n: number) => opts.data?.layers.find(l => l.id === n)?.name ?? '';
  const userName = (id: number) => opts.data?.users.find(u => u.id === id)?.name ?? '';
  const groupName = (id: number) => opts.data?.userGroups.find(u => u.id === id)?.name ?? '';

  function validate(): string | null {
    if (!name.trim()) return tr('Please enter a name for the workflow.');
    if (steps.length === 0) return tr('A workflow needs at least one step.');
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (!s.name.trim()) return tr('Step {0}: please enter a name.', i + 1);
      if (!s.editor && !s.userGroup) return tr('Step {0} ({1}): choose an editor or a user group.', i + 1, s.name);
    }
    return null;
  }
  async function save() {
    const v = validate(); if (v) { setMsg({ ok: false, t: v }); return; }
    const b: WfSaveBody = { name: name.trim(), active, description: desc.trim(), docTypes: types, userGroups: ugs, groups: grps, steps: steps.map(s => ({ ...s, name: s.name.trim() })) };
    setBusy(true);
    try {
      const r = selId === 'new' || selId === null ? await api.wfCreate(b) : await api.wfUpdate(selId, b);
      await qc.invalidateQueries({ queryKey: ['workflows'] });
      await load(r.id); setMsg({ ok: true, t: tr('Workflow saved.') });
    } catch (e) { setMsg({ ok: false, t: (e as Error).message }); setBusy(false); }
  }
  async function remove() {
    if (typeof selId !== 'number') return;
    setBusy(true);
    try { await api.wfDelete(selId); await qc.invalidateQueries({ queryKey: ['workflows'] }); setSelId(null); setDirty(false); setMsg({ ok: true, t: tr('Workflow deleted.') }); }
    catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); setAskDel(false); }
  }

  const folderList = useMemo(() => opts.data?.groups ?? [], [opts.data]);

  if (cfg.isLoading) return <PageLoader label={tr('Loading')} />;
  if (!cfg.data?.enabled) return <div className="um"><div className="card" style={{ padding: 20 }}>{tr('Workflow is switched off (Config')}{' '}<b>{tr('IsWorkflowEnabled')}</b>).</div></div>;
  if (!can) return <div className="um"><div className="card" style={{ padding: 20 }}>{tr('You need the')}{' '}<b>{tr('Workflow Management')}</b> {tr('right to open this page.')}</div></div>;

  const LAYER_ICO: Record<number, string> = { 1: '✏️', 2: '🔍', 3: '✅', 4: '🌐' };
  const shown = (list.data?.items ?? []).filter(w => !q.trim() || w.name.toLowerCase().includes(q.trim().toLowerCase()));
  const who = (s: WfStepBody) => [s.editor ? userName(s.editor) : '', s.userGroup ? groupName(s.userGroup) : ''].filter(Boolean).join(' · ') || 'not assigned';
  const pills = (items: { id: number; name: string }[] | undefined, arr: number[], set: (v: number[]) => void) => (
    <div className="wfx-pills">
      {(items ?? []).map(t => <button type="button" key={t.id} className={`wfx-pill ${arr.includes(t.id) ? 'on' : ''}`} aria-pressed={arr.includes(t.id)} onClick={() => toggle(arr, set, t.id)}>{arr.includes(t.id) && '✓ '}{t.name}</button>)}
      {(items ?? []).length === 0 && <span className="mh">{tr('Nothing to choose.')}</span>}
    </div>);

  return (
    <div className="um wfm wfx">
      <PageHero icon={<IconFlow />} title={tr('Workflow management')} sub={tr('Design processes with Edit, Verify, Release and Publish steps')}
        chips={[{ n: list.data?.items.length ?? '–', label: 'workflows' }, { n: list.data?.items.filter(x => x.active).length ?? '–', label: 'active' }]} />
      <div className="wfx-grid">
        <aside className="card wfx-side">
          <div className="wfx-side-head"><b>{tr('Workflows')}</b><button className="wfx-add" onClick={() => go('new')} disabled={busy}>{tr('＋ New')}</button></div>
          <input className="wfx-search" value={q} onChange={e => setQ(e.target.value)} placeholder={tr('Search workflows…')} aria-label={tr('Search workflows')} />
          {list.isLoading && <PageLoader compact label={tr('Loading workflows')} />}
          <div className="wfx-list">
            {shown.map(w => (
              <button key={w.id} className={`wfx-wf ${selId === w.id ? 'sel' : ''}`} onClick={() => selId !== w.id && go(w.id)}>
                <span className={`wfx-dot ${w.active ? 'on' : ''}`} title={w.active ? tr('Active') : tr('Inactive')} />
                <span className="wfx-wf-t"><b>{w.name}</b><small>{w.steps} {tr('step(s) ·')}{' '}{w.documents} {tr('document(s)')}</small></span>
              </button>))}
            {selId === 'new' && <div className="wfx-wf sel"><span className="wfx-dot" /><span className="wfx-wf-t"><b>{name || tr('New workflow')}</b><small>{tr('not saved yet')}</small></span></div>}
            {list.data && shown.length === 0 && <div className="mh" style={{ padding: 10 }}>{q ? tr('No workflow matches.') : tr('No workflows yet. Use “＋ New”.')}</div>}
          </div>
          <button className="btn-ghost wfx-test" disabled={busy} onClick={async () => {
            setBusy(true);
            try { const r = await api.wfMailTest(lang); setMsg({ ok: r.ok, t: r.message }); } catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); }
          }} title={tr('Sends a sample task e-mail to your own address to check the mail settings and the layout')}>{tr('✉ Send test e-mail to me')}</button>
        </aside>

        <section className="wfx-main">
          {selId === null ? (
            <div className="card wfx-empty">
              <div className="wfx-empty-ico"><IconFlow /></div>
              <h3>{tr('Select a workflow')}</h3>
              <p>{tr('Pick a workflow on the left to change its steps, or create a new process.')}</p>
              <button className="btn-primary" onClick={() => go('new')}>{tr('＋ New workflow')}</button>
            </div>
          ) : (<>
            <div className="card wfx-head">
              <div className="wfx-head-top">
                <input className="wfx-name" value={name} maxLength={50} placeholder={tr('Workflow name')} aria-label={tr('Workflow name')} onChange={e => touch(setName)(e.target.value)} />
                <label className={`wfx-switch ${active ? 'on' : ''}`} title={tr('Only active workflows can be started for a document')}>
                  <input type="checkbox" checked={active} onChange={e => touch(setActive)(e.target.checked)} /><span className="knob" /><span>{active ? tr('Active') : tr('Inactive')}</span></label>
              </div>
              <textarea className="wfx-desc" rows={2} maxLength={255} value={desc} placeholder={tr('Description (optional)')} aria-label={tr('Description')} onChange={e => touch(setDesc)(e.target.value)} />
              <div className="wfx-actions">
                {dirty && <span className="wfx-dirty">{tr('● Unsaved changes')}</span>}
                <span className="sp" />
                <button className="btn-ghost" onClick={() => setAskDel(true)} disabled={busy || typeof selId !== 'number'}>{tr('Delete')}</button>
                <button className="btn-ghost" onClick={() => go('close')}>{tr('Close')}</button>
                <button className="btn-primary" onClick={save} disabled={busy}>{busy ? <Spinner /> : tr('Save workflow')}</button>
              </div>
            </div>

            <div className="card wfx-pipe">
              <div className="wfx-sec"><h4>{tr('Process steps')}</h4><small className="mh">{tr('Click a step to edit it. When a document is added, any step can be chosen as the first one.')}</small></div>
              <div className="wfx-flow" role="list">
                {steps.map((st, i) => (
                  <div className="wfx-seg" key={i} role="listitem">
                    <button className={`wfx-node l${st.layer} ${i === selStep ? 'sel' : ''}`} onClick={() => setSelStep(i)}>
                      <span className="wfx-num">{i + 1}</span>
                      <span className="wfx-nico" aria-hidden="true">{LAYER_ICO[st.layer] ?? '•'}</span>
                      <b>{st.name || tr('New step')}</b>
                      <small>{layerName(st.layer)}</small>
                      <span className="wfx-who">{who(st)}</span>
                      <span className="wfx-days">⏱ {st.days} {tr('day(s)')}</span>
                    </button>
                    {i < steps.length - 1 && <span className="wfx-arrow" aria-hidden="true">➜</span>}
                  </div>))}
                <button className="wfx-node wfx-addstep" onClick={addStep}><span className="wfx-plus">＋</span><b>{tr('Add step')}</b></button>
              </div>

              {step ? (
                <div className="wfx-step">
                  <div className="wfx-step-head">
                    <b>{tr('Step')}{' '}{selStep + 1}: {step.name || 'new step'}</b>
                    <span className="wfx-step-btns">
                      <button className="btn-ghost" onClick={() => move(-1)} disabled={selStep <= 0} title={tr('Move earlier')}>{tr('◀ Earlier')}</button>
                      <button className="btn-ghost" onClick={() => move(1)} disabled={selStep >= steps.length - 1} title={tr('Move later')}>{tr('Later ▶')}</button>
                      <button className="btn-ghost danger" onClick={removeStep} title={tr('Remove step')}>{tr('Remove')}</button>
                    </span>
                  </div>
                  <div className="wfx-step-grid">
                    <label>{tr('Step name')}<input value={step.name} maxLength={50} onChange={e => patchStep({ name: e.target.value })} /></label>
                    <label>{tr('Step type')}<select value={step.layer} onChange={e => patchStep({ layer: Number(e.target.value) })}>
                      {opts.data?.layers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
                    <label>{tr('Editor')}<select value={step.editor} onChange={e => patchStep({ editor: Number(e.target.value) })}>
                      <option value={0}>{tr('– none –')}</option>{opts.data?.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
                    <label>{tr('User group')}<select value={step.userGroup} onChange={e => patchStep({ userGroup: Number(e.target.value) })}>
                      <option value={0}>{tr('– none –')}</option>{opts.data?.userGroups.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
                    <label>{tr('Processing time (days)')}<input type="number" min={0} max={100} value={step.days}
                      onChange={e => patchStep({ days: Math.max(0, Math.min(100, Math.trunc(Number(e.target.value)) || 0)) })} /></label>
                    <label className="wide">{tr('Description')}<textarea rows={2} maxLength={255} value={step.description} onChange={e => patchStep({ description: e.target.value })} /></label>
                  </div>
                  <small className="mh">{tr('The editor is the default assignee. With a user group, any member can be picked at hand-over.')}</small>
                </div>
              ) : <div className="mh" style={{ padding: 10 }}>{tr('Add a step to build the process.')}</div>}
            </div>

            <div className="card wfx-valid">
              <div className="wfx-sec"><h4>{tr('Valid for')}</h4><small className="mh">{tr('Nothing selected = no restriction.')}</small></div>
              <div className="wfx-three">
                <div><div className="wfx-vh"><b>{tr('Document types')}</b><span className="wfx-cnt">{types.length || 'all'}</span></div>{pills(opts.data?.docTypes, types, setTypes)}</div>
                <div><div className="wfx-vh"><b>{tr('User groups')}</b><span className="wfx-cnt">{ugs.length || 'all'}</span></div>{pills(opts.data?.userGroups, ugs, setUgs)}</div>
                <div><div className="wfx-vh"><b>{tr('Folders (incl. subfolders)')}</b><span className="wfx-cnt">{grps.length || 'all'}</span></div>{pills(folderList, grps, setGrps)}</div>
              </div>
            </div>
          </>)}
        </section>
      </div>
      {askDel && <ConfirmDialog danger title={tr('Delete workflow?')} confirmLabel={tr('Delete')} busy={busy}
        message={<>{tr('The workflow')}{' '}<b>{name}</b> {tr('and its steps will be removed. This is only possible while no document is (or was) in it.')}</>}
        onConfirm={remove} onCancel={() => setAskDel(false)} />}
      {pendingSel !== null && <ConfirmDialog title={tr('Discard changes?')} confirmLabel={tr('Discard')} message={tr('The workflow has unsaved changes.')}
        onConfirm={() => { setDirty(false); doGo(pendingSel); }} onCancel={() => setPendingSel(null)} />}
      <Toast msg={msg} onClose={() => setMsg(null)} />
    </div>
  );
}
