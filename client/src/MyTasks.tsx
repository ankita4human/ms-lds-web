import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, type WfTaskItem } from './api';
import { useLang } from './LangContext';
import { PageLoader } from './components/Loader';
import { IconTask } from './components/Icons';
import { ExtBadge, StatusBadge } from './components/bits';
import PageHero from './components/PageHero';
import WorkflowRunDialog from './components/WorkflowRunDialog';
import Toast from './components/Toast';

const fmt = (s?: string) => (s ? new Date(s).toLocaleDateString('en-GB') : '-');
const ICO: Record<number, string> = { 1: '✏️', 2: '🔍', 3: '✅', 4: '🌐' };
const PALETTE = ['#2f6df6', '#7a5af8', '#0e9384', '#dd6b20', '#d6336c', '#2e90fa', '#16a34a', '#b54708'];
const colorOf = (s: string) => PALETTE[[...s].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7) % PALETTE.length];
const initials = (s: string) => s.split(/[\s.@_-]+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '?';

function dueInfo(t: WfTaskItem): { text: string; cls: string } {
  if (!t.due) return { text: '', cls: '' };
  const days = Math.round((new Date(t.due).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
  if (days < 0) return { text: `${-days} day${days === -1 ? '' : 's'} overdue`, cls: 'late' };
  if (days === 0) return { text: 'due today', cls: 'soon' };
  if (days === 1) return { text: 'due tomorrow', cls: 'soon' };
  return { text: `in ${days} days`, cls: 'ok' };
}
type Sort = 'doc' | 'due' | 'assigned' | 'step';

/** "My tasks" (Meine Aufgaben): the documents that wait for the signed-in user in a workflow, per task type. */
export default function MyTasks() {
  const { lang } = useLang();
  const nav = useNavigate();
  const [layer, setLayer] = useState(0);
  const [text, setText] = useState('');
  const [sort, setSort] = useState<Sort>('due'); const [desc, setDesc] = useState(false);
  const [open, setOpen] = useState<{ idDoc: number; docName: string } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const q = useQuery({ queryKey: ['wf-tasks', lang, layer], queryFn: () => api.wfTasks(lang, layer), enabled: !!lang, staleTime: 0 });
  const c = q.data?.counts ?? [];
  const names = q.data?.layerNames ?? ['Edit', 'Verify', 'Release', 'Publish'];
  const total = (c[1] ?? 0) + (c[2] ?? 0) + (c[3] ?? 0) + (c[4] ?? 0);
  const tiles = [{ id: 0, label: 'All tasks', n: total, ico: '📋', cls: 'l0' }, ...[1, 2, 3, 4].map(i => ({ id: i, label: names[i - 1] ?? '', n: c[i] ?? 0, ico: ICO[i]!, cls: `l${i}` }))];

  const rows = useMemo(() => {
    const f = text.trim().toLowerCase();
    let r = (q.data?.items ?? []).filter(t => !f || t.docName.toLowerCase().includes(f) || t.workflow.toLowerCase().includes(f) || t.step.toLowerCase().includes(f) || t.startedBy.toLowerCase().includes(f) || String(t.idDoc) === f);
    const key = (t: WfTaskItem) => sort === 'doc' ? t.docName.toLowerCase() : sort === 'due' ? (t.due ?? '9999') : sort === 'assigned' ? (t.assigned ?? '') : `${t.layer}${t.step}`;
    r = [...r].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * (desc ? -1 : 1));
    return r;
  }, [q.data, text, sort, desc]);
  const overdue = (q.data?.items ?? []).filter(t => t.overdue).length;
  const head = (label: string, key: Sort) => <th onClick={() => { setDesc(sort === key ? !desc : false); setSort(key); }}>{label}{sort === key ? (desc ? ' ▾' : ' ▴') : ''}</th>;

  return (
    <div className="um">
      <PageHero icon={<IconTask />} title="My tasks" sub="Documents waiting for you in a workflow" chips={[{ n: total, label: 'open tasks' }, { n: overdue, label: 'overdue' }]} />
      <div className="mt-tiles" role="tablist" aria-label="Task type">
        {tiles.map(t => (
          <button key={t.id} role="tab" aria-selected={layer === t.id} className={`mt-tile ${t.cls} ${layer === t.id ? 'on' : ''}`} onClick={() => setLayer(t.id)}>
            <span className="mt-ico" aria-hidden="true">{t.ico}</span><span className="mt-n">{t.n}</span><span className="mt-l">{t.label}</span></button>))}
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="mt-bar">
          <input className="mt-search" value={text} onChange={e => setText(e.target.value)} placeholder="Search document, workflow, step or sender…" aria-label="Search tasks" />
          <span className="mh">{rows.length} task{rows.length === 1 ? '' : 's'}</span>
        </div>
        {q.isLoading && <PageLoader compact label="Loading tasks" />}
        {q.error && <div className="alert" style={{ margin: 12 }}>{(q.error as Error).message}</div>}
        {q.data && !q.data.enabled && <div className="mh" style={{ padding: 16 }}>Workflow is switched off.</div>}
        {q.data?.enabled && rows.length === 0 && (
          <div className="mt-empty"><div className="mt-empty-ico">🎉</div><b>{text ? 'No task matches your search.' : 'Nothing waiting for you.'}</b><small>{text ? 'Try another word.' : 'New tasks show up here and in the notification bell.'}</small></div>)}
        {rows.length > 0 && (
          <div className="mt-scroll">
            <table className="grid-table mt-tbl">
              <thead><tr>{head('Document', 'doc')}<th>Status</th><th>Version</th><th>Workflow</th>{head('Step', 'step')}<th>From</th>{head('Assigned', 'assigned')}{head('Due', 'due')}<th /></tr></thead>
              <tbody>{rows.map(t => {
                const d = dueInfo(t);
                return (
                  <tr key={t.taskId} className={t.overdue ? 'mt-late' : ''} onDoubleClick={() => setOpen({ idDoc: t.idDoc, docName: t.docName })}>
                    <td title={t.docName}>
                      <span className="mt-doc"><ExtBadge ext={t.ext} />
                        <span className="mt-doc-t"><a href={`/documents?doc=${t.idDoc}`} onClick={e => { e.preventDefault(); nav(`/documents?doc=${t.idDoc}`); }}><b>{t.docName}</b></a><small>#{t.idDoc} · {t.lang}</small></span></span></td>
                    <td><StatusBadge id={t.status} name={t.statusName} /></td>
                    <td>{t.version}</td>
                    <td>{t.workflow}</td>
                    <td><span className={`mt-step l${t.layer}`}>{ICO[t.layer]} {t.step || t.layerName}<small>{t.layerName}</small></span></td>
                    <td><span className="mt-from"><span className="mt-av" style={{ background: colorOf(t.startedBy || '?') }}>{initials(t.startedBy)}</span>{t.startedBy}</span></td>
                    <td>{fmt(t.assigned)}</td>
                    <td><span className={`mt-due ${d.cls}`}>{fmt(t.due)}{d.text && <small>{d.text}</small>}</span></td>
                    <td><button className="btn-primary mt-go" onClick={() => setOpen({ idDoc: t.idDoc, docName: t.docName })}>Process</button></td>
                  </tr>);
              })}</tbody></table>
          </div>)}
      </div>
      {open && <WorkflowRunDialog doc={open} lang={lang} onClose={() => setOpen(null)} onDone={m => { setOpen(null); setMsg({ ok: !/no mail was sent|could not be sent/i.test(m), t: m }); q.refetch(); }} />}
      <Toast msg={msg} onClose={() => setMsg(null)} />
    </div>
  );
}
