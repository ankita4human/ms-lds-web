import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileIcon } from './bits';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import UserAvatar from './UserAvatar';
import { api, type PubFeedItem, type PubJob, type WfTaskNote } from '../api';
import { tr } from '../i18n';

/** Bell in the top bar: publishing queue (live) + a "who published what" timeline, Facebook style (manual p. 109 Publish). */

const SEEN = 'pl_notif_seen';
const readSeen = () => { try { return localStorage.getItem(SEEN); } catch { return null; } };
const writeSeen = (v: string) => { try { localStorage.setItem(SEEN, v); } catch { /* private mode */ } };


const PALETTE = ['#2f6df6', '#7a5af8', '#0e9384', '#dd6b20', '#d6336c', '#2e90fa', '#16a34a', '#b54708'];
const colorOf = (s: string) => PALETTE[[...s].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7) % PALETTE.length];
const initials = (s: string) => s.split(/[\s.@_-]+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '?';

const when = (iso: string) => new Date(iso);
function ago(iso: string) {
  const s = Math.max(0, (Date.now() - when(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
const full = (iso: string) => when(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
function dayLabel(iso: string) {
  const a = when(iso); const t = new Date();
  const d0 = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((d0(t) - d0(a)) / 86400000);
  return diff <= 0 ? 'Today' : diff === 1 ? 'Yesterday' : diff < 7 ? tr('This week') : 'Earlier';
}
const key = (i: PubFeedItem) => `${i.idDoc}-${i.lang}-${i.publishedOn}`;

const TASK_SEEN = 'pl_task_seen';
const readTaskSeen = (me: number): Set<number> | null => { try { const v = localStorage.getItem(`${TASK_SEEN}_${me}`); return v ? new Set(JSON.parse(v) as number[]) : null; } catch { return null; } };
const writeTaskSeen = (me: number, ids: number[]) => { try { localStorage.setItem(`${TASK_SEEN}_${me}`, JSON.stringify(ids)); } catch { /* private mode */ } };
const TASK_ICO: Record<number, string> = { 1: '✏️', 2: '🔍', 3: '✅', 4: '🌐' };
const TASK_TXT: Record<number, string> = { 1: 'to edit', 2: 'to verify', 3: 'to release', 4: 'to publish' };
const dueTxt = (t: WfTaskNote) => t.due ? `${t.overdue ? 'overdue since' : 'due'} ${new Date(t.due).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}` : '';

type Snack = { id: number; ok: boolean; title: string; text: string };

export default function NotificationBell({ lang }: { lang: string }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<string>(() => readSeen() ?? new Date().toISOString());
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [snacks, setSnacks] = useState<Snack[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const prev = useRef<Map<string, string>>(new Map());
  const prevMail = useRef(new Map<string, string>());
  const ready = useRef(false);
  const snackId = useRef(0);

  const q = useQuery({
    queryKey: ['notifications', lang], queryFn: () => api.notifications(lang),
    refetchInterval: d => (d.state.data?.jobs.some(j => j.status === 'queued' || j.status === 'running') ? 2500 : 15000),
    refetchOnWindowFocus: true,
  });
  const sum = useQuery({ queryKey: ['wf-summary'], queryFn: api.wfSummary, refetchInterval: 30_000, refetchOnWindowFocus: true, staleTime: 10_000 });
  const tasks = sum.data?.enabled ? sum.data.items : [];
  const taskTotal = sum.data?.enabled ? sum.data.total : 0;
  const meQ = useQuery({ queryKey: ['me'], queryFn: api.me });
  const myName = meQ.data?.name || meQ.data?.accShort;
  const data = q.data;
  const me = data?.me;
  const jobs = data?.jobs ?? [];
  const items = data?.items ?? [];
  const active = jobs.filter(j => j.status === 'queued' || j.status === 'running');
  const failed = jobs.filter(j => j.status === 'failed');
  const unreadItems = useMemo(() => items.filter(i => i.publishedById !== me && when(i.publishedOn) > new Date(seen)), [items, me, seen]);
  const badge = unreadItems.length + failed.length + taskTotal;

  useEffect(() => { if (readSeen() === null) writeSeen(seen); }, [seen]);
  useEffect(() => { const h = () => qc.invalidateQueries({ queryKey: ['notifications'] }); window.addEventListener('pl-publish-queued', h); return () => window.removeEventListener('pl-publish-queued', h); }, [qc]);

  const pushSnack = useCallback((s: Omit<Snack, 'id'>) => {
    const id = ++snackId.current;
    setSnacks(l => [...l.slice(-2), { ...s, id }]);
    setTimeout(() => setSnacks(l => l.filter(x => x.id !== id)), s.ok ? 7000 : 14000);
  }, []);

  // A job that was waiting / running and is now finished: tell the user and refresh the document lists.
  useEffect(() => {
    if (!data) return;
    const p = prev.current;
    if (ready.current) {
      for (const j of data.jobs) {
        const was = p.get(j.id);
        if (was && (was === 'queued' || was === 'running') && j.status === 'done') {
          pushSnack({ ok: true, title: tr('Published'), text: tr('“{0}” ({1}, v{2}) is now on the web{3}.', j.docName, j.lang, j.version, j.warnings?.length ? ` - note: ${j.warnings[0]}` : '') });
          ['docs', 'doc', 'doc-deep', 'stats', 'groups'].forEach(x => qc.invalidateQueries({ queryKey: [x] }));
        } else if (was && (was === 'queued' || was === 'running') && j.status === 'failed')
          pushSnack({ ok: false, title: tr('Publishing failed'), text: `“${j.docName}”: ${j.error ?? 'unknown error'}` });
      }
    }
    if (ready.current) for (const j of data.jobs) {
      const was = prevMail.current.get(j.id);
      if (j.mailStatus && was !== j.mailStatus) {
        if (j.mailStatus === 'sent') pushSnack({ ok: true, title: tr('E-mail sent'), text: tr('The publish e-mail for “{0}” was sent.', j.docName) });
        else if (j.mailStatus === 'failed') pushSnack({ ok: false, title: tr('E-mail not sent'), text: `“${j.docName}”: ${j.mailError ?? 'the mail server did not accept the message'}` });
      }
    }
    prevMail.current.clear(); data.jobs.forEach(j => { if (j.mailStatus) prevMail.current.set(j.id, j.mailStatus); });
    p.clear(); data.jobs.forEach(j => p.set(j.id, j.status)); ready.current = true;
  }, [data, pushSnack, qc]);

  // New tasks assigned to me (document to edit / verify / release / publish): snackbar + browser notification, once per task.
  useEffect(() => {
    if (!sum.data?.enabled || me === undefined) return;
    const ids = sum.data.items.map(t => t.taskId);
    const known = readTaskSeen(me);
    const fresh = known === null ? sum.data.items : sum.data.items.filter(t => !known.has(t.taskId));
    writeTaskSeen(me, ids);
    if (fresh.length === 0) return;
    const one = fresh.length === 1 ? fresh[0]! : null;
    const title = one ? tr('A document is waiting {0}', TASK_TXT[one.layer] ?? '') : `${fresh.length} documents are waiting for you`;
    const text = one ? `“${one.docName}”${one.workflow ? ` · ${one.workflow}` : ''}${one.startedBy ? tr(' · from {0}', one.startedBy) : ''}` : fresh.slice(0, 3).map(t => `“${t.docName}” ${TASK_TXT[t.layer] ?? ''}`).join('; ') + (fresh.length > 3 ? ' …' : '');
    pushSnack({ ok: true, title, text });
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        const n = new Notification(title, { body: text, tag: 'pl-tasks', icon: '/logo-qf.png' });
        n.onclick = () => { window.focus(); nav('/tasks'); n.close(); };
      }
    } catch { /* notifications not available */ }
  }, [sum.data, me, pushSnack, nav]);

  // close on outside click / Escape
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', click); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', click); document.removeEventListener('keydown', esc); };
  }, [open]);

  function toggle() {
    if (!open) {
      try { if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission(); } catch { /* ignore */ }
      setFresh(new Set(unreadItems.map(key)));        // keep them highlighted while the window is open
      const now = new Date().toISOString(); setSeen(now); writeSeen(now);
      q.refetch();
    }
    setOpen(o => !o);
  }
  async function dismiss(j: PubJob) { await api.dismissJob(j.id).catch(() => undefined); qc.invalidateQueries({ queryKey: ['notifications'] }); }
  async function clearDone() { await api.dismissAllJobs().catch(() => undefined); qc.invalidateQueries({ queryKey: ['notifications'] }); }

  const groups = useMemo(() => {
    const g: { label: string; rows: PubFeedItem[] }[] = [];
    for (const i of items) { const l = dayLabel(i.publishedOn); const last = g[g.length - 1]; if (last?.label === l) last.rows.push(i); else g.push({ label: l, rows: [i] }); }
    return g;
  }, [items]);
  const finished = jobs.filter(j => j.status === 'done' || j.status === 'failed');

  return (
    <div className="nb" ref={box}>
      <button className={`nb-btn ${badge > 0 ? 'nb-shake' : ''} ${open ? 'on' : ''}`} onClick={toggle} aria-haspopup="dialog" aria-expanded={open}
        aria-label={badge > 0 ? tr('Notifications, {0} new', badge) : tr('Notifications')} title={tr('Notifications')}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>
        {badge > 0 && <span className="nb-badge">{badge > 99 ? '99+' : badge}</span>}
        {badge === 0 && active.length > 0 && <span className="nb-pulse" aria-hidden="true" />}
      </button>

      {open && (
        <div className="nb-panel" role="dialog" aria-label={tr('Notifications')}>
          <div className="nb-head">
            <div><h3>{tr('Notifications')}</h3>
              <small>{taskTotal > 0 ? tr('{0} task{1} waiting for you · ', taskTotal, taskTotal === 1 ? '' : 's') : ''}{data ? tr('{0} document{1} published in the last {2} days', data.total, data.total === 1 ? '' : 's', data.days) : tr('Loading...')}</small></div>
            <span className="nb-ico" aria-hidden="true">📣</span>
          </div>

          <div className="nb-body">
            {tasks.length > 0 && (
              <div className="nb-sec">
                <div className="nb-sec-h"><span>{tr('Waiting for you (')}{taskTotal})</span><button onClick={() => { setOpen(false); nav('/tasks'); }}>{tr('Open My tasks')}</button></div>
                {tasks.slice(0, 8).map(t => (
                  <button key={t.taskId} className={`nb-item nb-task ${t.overdue ? 'late' : ''}`} onClick={() => { setOpen(false); nav('/tasks'); }}>
                    <span className="nb-av"><span className="nb-av-i" style={{ background: t.overdue ? '#d92d20' : '#4f46e5' }}>{TASK_ICO[t.layer] ?? '•'}</span></span>
                    <span className="nb-tx">
                      <span className="nb-line"><b>{t.docName}</b> {TASK_TXT[t.layer] ?? ''}</span>
                      <span className="nb-chips">{t.workflow && <em>{t.workflow}</em>}<em>{t.step || t.layerName}</em><em>{t.lang}</em>{t.due && <em className={t.overdue ? 'late' : ''}>{dueTxt(t)}</em>}</span>
                      {t.startedBy && <span className="nb-time">{tr('from')}{' '}{t.startedBy}{t.assigned ? ` · ${ago(t.assigned)}` : ''}</span>}
                    </span>
                  </button>))}
                {tasks.length > 8 && <div className="nb-foot" style={{ padding: '4px 10px' }}>+ {tasks.length - 8} {tr('more in My tasks')}</div>}
              </div>
            )}

            {(active.length > 0 || finished.length > 0) && (
              <div className="nb-sec">
                <div className="nb-sec-h"><span>{tr('Your publishing')}</span>{finished.length > 0 && <button onClick={clearDone}>{tr('Clear finished')}</button>}</div>
                {[...active.slice().reverse(), ...finished].map(j => (
                  <div key={j.id} className={`nb-job ${j.status}`}>
                    <span className="nb-job-ic" aria-hidden="true">
                      {j.status === 'running' ? <span className="nb-spin" /> : j.status === 'queued' ? '🕒' : j.status === 'done' ? '✓' : '!'}</span>
                    <div className="nb-job-tx">
                      <b title={j.docName}>{j.docName}</b>
                      <small>{j.status === 'queued' ? tr('Waiting in the queue{0}', j.position > 1 ? ` · position ${j.position}` : '') : j.status === 'running' ? tr('Publishing now - writing HTML, PDF and original...')
                        : j.status === 'done' ? tr('Published · {0} file{1}{2}{3}', j.files, j.files === 1 ? '' : 's', j.tagsReplaced ? ` · ${j.tagsReplaced} tag${j.tagsReplaced === 1 ? '' : 's'} replaced` : '', j.mailStatus ? ` · e-mail ${j.mailStatus === 'failed' ? `failed: ${j.mailError ?? ''}` : j.mailStatus}` : '') : j.error}</small>
                      {j.status === 'running' && <div className="nb-bar"><i /></div>}
                    </div>
                    {(j.status === 'done' || j.status === 'failed') && <button className="nb-x" onClick={() => dismiss(j)} aria-label={tr('Dismiss')} title={tr('Dismiss')}>×</button>}
                  </div>
                ))}
              </div>
            )}

            {q.isLoading && <div className="nb-empty">{tr('Loading...')}</div>}
            {!q.isLoading && items.length === 0 && (
              <div className="nb-empty"><div className="nb-empty-ic">🔔</div><b>{tr('Nothing published yet')}</b><small>{tr('Published documents of the last')}{' '}{data?.days ?? 30} {tr('days show up here.')}</small></div>
            )}

            {groups.map(g => (
              <div key={g.label} className="nb-sec">
                <div className="nb-sec-h"><span>{g.label}</span></div>
                {g.rows.map(i => {
                  const mine = i.publishedById === me;
                  return (
                    <button key={key(i)} className={`nb-item ${fresh.has(key(i)) ? 'new' : ''}`} onClick={() => { setOpen(false); nav(`/documents?doc=${i.idDoc}`); }}>
                      <span className="nb-av">
                        {mine ? <UserAvatar id={me} className="nb-me" name={myName} /> : <span className="nb-av-i" style={{ background: colorOf(i.publishedBy) }}>{initials(i.publishedBy)}</span>}
                        <span className="nb-ft nb-ft-ico" title={i.ext ? `.${i.ext}` : 'file'}><FileIcon ext={i.ext} size={26} /></span>
                      </span>
                      <span className="nb-tx">
                        <span className="nb-line"><b>{mine ? tr('You') : i.publishedBy}</b> {tr('published')}{' '}<b>{i.docName}</b></span>
                        <span className="nb-chips">
                          {i.type && <em>{i.type}</em>}<em>{tr('v')}{i.version}</em><em>{i.lang}</em>
                          <em className="id">#{i.idDoc}</em>
                        </span>
                        <span className="nb-time" title={full(i.publishedOn)}>🕒 {ago(i.publishedOn)} · {full(i.publishedOn)}</span>
                      </span>
                      {fresh.has(key(i)) && <span className="nb-dot" aria-label={tr('New')} />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          {data && data.total > items.length && <div className="nb-foot">{tr('Showing the latest')}{' '}{items.length} {tr('of')}{' '}{data.total}</div>}
        </div>
      )}

      <div className="nb-snacks" aria-live="polite">
        {snacks.map(s => (
          <div key={s.id} className={`nb-snack ${s.ok ? 'ok' : 'bad'}`} role={s.ok ? 'status' : 'alert'}>
            <span className="nb-snack-ic" aria-hidden="true">{s.ok ? '✓' : '!'}</span>
            <div><b>{s.title}</b><p>{s.text}</p></div>
            <button onClick={() => setSnacks(l => l.filter(x => x.id !== s.id))} aria-label={tr('Close')}>×</button>
          </div>
        ))}
      </div>
    </div>
  );
}
