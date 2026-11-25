import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, simulation, downloadUserRights, type IdLabel, type RightItem } from './api';
import { useLang } from './LangContext';
import { Spinner, PageLoader } from './components/Loader';
import ConfirmDialog from './components/ConfirmDialog';
import Toast from './components/Toast';
import { IconUsers } from './components/Icons';
import PageHero from './components/PageHero';
import { Switch, SaveBar, useSaveShortcut } from './components/FormBits';

type Msg = { ok: boolean; t: string } | null;

/** Small modal used for "Choose Rights", "Choose Groups", "Choose Users", "Copy From" and "Change password". */
function Pick({ title, legend, items, onOk, onCancel, extra, busy }: {
  title: string; legend?: string; items: IdLabel[]; onOk: (id: number) => void; onCancel: () => void; extra?: React.ReactNode; busy?: boolean;
}) {
  const [q, setQ] = useState(''); const [sel, setSel] = useState<number | null>(null);
  const shown = items.filter(i => i.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="modal-back" style={{ zIndex: 90 }} onMouseDown={() => !busy && onCancel()}>
      <div className="modal um-pick" role="dialog" aria-modal="true" aria-label={title} onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head"><b>{title}</b></div>
        <div className="um-pick-body">
          {legend && <div className="um-legend">{legend}</div>}
          <input placeholder="Search…" value={q} onChange={e => setQ(e.target.value)} autoFocus />
          <div className="um-list">
            {shown.map(i => <div key={i.id} className={`um-item ${sel === i.id ? 'sel' : ''}`} onClick={() => setSel(i.id)} onDoubleClick={() => onOk(i.id)}>{i.name}</div>)}
            {shown.length === 0 && <div className="mh" style={{ padding: 8 }}>Nothing to choose.</div>}
          </div>
          {extra}
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn-primary" disabled={sel === null || busy} onClick={() => sel !== null && onOk(sel)}>{busy ? <Spinner /> : 'OK'}</button>
        </div>
      </div>
    </div>
  );
}

function PasswordDialog({ onOk, onCancel, busy, error }: { onOk: (p: string) => void; onCancel: () => void; busy: boolean; error: string | null }) {
  const [a, setA] = useState(''); const [b, setB] = useState(''); const [show, setShow] = useState(false);
  const score = (a.length >= 8 ? 1 : 0) + (/[a-z]/i.test(a) && /\d/.test(a) ? 1 : 0) + (/[^a-z0-9]/i.test(a) ? 1 : 0) + (a.length >= 12 ? 1 : 0);
  const local = a && b && a !== b ? 'The two entries are not identical.' : null;
  return (
    <div className="modal-back" style={{ zIndex: 90 }} onMouseDown={() => !busy && onCancel()}>
      <div className="modal um-pick" role="dialog" aria-modal="true" aria-label="Change password" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head"><b>Change password</b></div>
        <div className="um-pick-body">
          <label className="fm-row">New password<input type={show ? 'text' : 'password'} value={a} onChange={e => setA(e.target.value)} autoFocus autoComplete="new-password" /></label>
          <label className="fm-row">Repeat<input type={show ? 'text' : 'password'} value={b} onChange={e => setB(e.target.value)} autoComplete="new-password" /></label>
          <label className="fm-chk"><input type="checkbox" checked={show} onChange={e => setShow(e.target.checked)} />Show password</label>
          <div className="fx-strength" aria-hidden="true"><i className={`s${score}`} /></div><small className="mh">{['Too short','Weak','Fair','Good','Strong'][score]} · at least 8 characters with letters, numbers and special characters.</small>
          {(local || error) && <div className="alert" role="alert">{local ?? error}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn-primary" disabled={busy || !a || a !== b} onClick={() => onOk(a)}>{busy ? <Spinner /> : 'Change'}</button>
        </div>
      </div>
    </div>
  );
}

/** Choose Rights window: pick a right; "Single group" additionally needs the group. */
function RightPicker({ lang, legend, taken, onOk, onCancel, busy }: { lang: string; legend: string; taken: number[]; onOk: (rcod: number, rvalue: string) => void; onCancel: () => void; busy: boolean }) {
  const cat = useQuery({ queryKey: ['rights-catalog', lang], queryFn: () => api.rightsCatalog(lang) });
  const [pending, setPending] = useState<number | null>(null);
  if (!cat.data) return <div className="modal-back" style={{ zIndex: 90 }}><div className="modal um-pick"><PageLoader compact label="Loading rights" /></div></div>;
  if (pending !== null) {
    return <Pick title="Choose the group for 'Single group'" busy={busy} onCancel={() => setPending(null)}
      items={cat.data.groups.map(g => ({ id: g.id, name: g.name ?? String(g.id) }))}
      onOk={id => onOk(pending, String(id))} />;
  }
  return <Pick title="Choose Rights" legend={legend} busy={busy} onCancel={onCancel} items={cat.data.rights.filter(r => r.id === cat.data!.singleGroupCode || !taken.includes(r.id))}
    onOk={id => id === cat.data!.singleGroupCode ? setPending(id) : onOk(id, '')} />;
}

const initials = (n: string) => n.split(/[\s.]+/).filter(Boolean).slice(0, 2).map(x => x[0]!.toUpperCase()).join('') || '?';
const avColor = (n: string) => { let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360; return `linear-gradient(135deg, hsl(${h} 70% 52%), hsl(${(h + 40) % 360} 75% 42%))`; };
const okMail = (s: string) => !s.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

/** A titled list with search, a + button and a remove (×) button on every row. */
function Panel({ title, icon, items, onAdd, onRemove, busy, empty, avatar, readOnly }: {
  title: string; icon: string; items: { id: number; name: string }[]; onAdd?: () => void; onRemove?: (id: number) => void; busy?: boolean; empty: string; avatar?: boolean; readOnly?: boolean;
}) {
  const [q, setQ] = useState('');
  const shown = items.filter(i => i.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="fx-panel">
      <div className="fx-panel-head"><b><span>{icon}</span>{title}<em>{items.length}</em></b>
        {onAdd && <button className="fx-add" onClick={onAdd} disabled={busy || readOnly}>＋ Add</button>}</div>
      {items.length > 6 && <input className="fx-mini" placeholder={`Find in ${title.toLowerCase()}…`} value={q} onChange={e => setQ(e.target.value)} />}
      <div className="fx-rows">
        {shown.map(i => (
          <div key={i.id} className="fx-row">
            {avatar && <span className="um-av" style={{ background: avColor(i.name) }}>{initials(i.name)}</span>}
            <span className="nm">{i.name}</span>
            {onRemove && <button aria-label={`Remove ${i.name}`} title="Remove" disabled={busy || readOnly} onClick={() => onRemove(i.id)}>×</button>}
          </div>
        ))}
        {shown.length === 0 && <div className="fx-empty">{items.length ? 'Nothing matches.' : empty}</div>}
      </div>
    </div>
  );
}

const EMPTY_F = { name: '', login: '', email: '', active: false, ntAuth: false, processOwner: false };

export default function UserManagement() {
  const { lang } = useLang();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [tab, setTab] = useState<'user' | 'group'>('user');
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setMsg(null); try { await fn(); } catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); } };
  const inv = (...k: string[]) => Promise.all(k.map(x => qc.invalidateQueries({ queryKey: [x] })));
  const refresh = async () => { await inv('um-users', 'um-user', 'um-user-all', 'um-groups', 'um-group'); };

  /* ---------------- users ---------------- */
  const [status, setStatus] = useState<'all' | 'active' | 'inactive'>('all');
  const [uq, setUq] = useState('');
  const users = useQuery({ queryKey: ['um-users', 'all'], queryFn: () => api.users('all') });
  const allUsers = users;
  const [uid, setUid] = useState<number | 'new' | null>(null);
  const detail = useQuery({ queryKey: ['um-user', uid, lang], queryFn: () => api.user(uid as number, lang), enabled: typeof uid === 'number' });
  const [f, setF] = useState(EMPTY_F);
  const [base, setBase] = useState('');
  const [dlg, setDlg] = useState<null | 'right' | 'group' | 'copy' | 'pwd' | 'del' | 'all'>(null);
  const [rm, setRm] = useState<null | { title: string; text: React.ReactNode; fn: () => Promise<void> }>(null);
  const [pwdErr, setPwdErr] = useState<string | null>(null);
  const [pendingU, setPendingU] = useState<number | 'new' | null | undefined>(undefined);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (uid === 'new') { setF(EMPTY_F); setBase(JSON.stringify(EMPTY_F)); setMsg(null); return; }
    const h = detail.data?.head;
    if (h) { const v = { name: h.name, login: h.login, email: h.email, active: h.active, ntAuth: h.ntAuth, processOwner: h.processOwner }; setF(v); setBase(JSON.stringify(v)); setMsg(null); }
  }, [uid, detail.data?.head?.idAcc]); // eslint-disable-line react-hooks/exhaustive-deps

  const cur = detail.data;
  const isNew = uid === 'new';
  const sync = cur?.head.isSync ?? false;
  const dirty = uid !== null && JSON.stringify(f) !== base;
  const set = (p: Partial<typeof f>) => setF(x => ({ ...x, ...p }));
  const errName = touched && !f.name.trim() ? 'Please enter the user name.' : '';
  const errLogin = touched && !f.login.trim() ? 'Please enter the login name.' : '';
  const errMail = !okMail(f.email) ? 'This e-mail address does not look right.' : '';
  const openUser = (id: number | 'new' | null) => { if (dirty && id !== uid) setPendingU(id); else { setTouched(false); setUid(id); } };

  const saveUser = () => run(async () => {
    setTouched(true);
    if (!f.name.trim() || !f.login.trim()) throw new Error('User name and login name are required.');
    if (errMail) throw new Error(errMail);
    const r = uid === 'new' ? await api.createUser(f) : await api.updateUser(uid as number, f);
    await refresh(); setBase(JSON.stringify(f)); setUid(r.idAcc);
    setMsg({ ok: true, t: uid === 'new' ? 'User created (inactive). Set a password, assign rights and activate the user.' : 'User saved.' });
  });
  const simulate = () => run(async () => { const r = await api.simulateUser(uid as number); simulation.start(r.token, r.login); location.assign('/documents'); });
  const resetU = () => { try { setF(JSON.parse(base)); setTouched(false); } catch { /* none */ } };

  const ulist = useMemo(() => (users.data?.items ?? []).filter(u =>
    (status === 'all' || (status === 'active' ? u.active : !u.active)) &&
    (!uq.trim() || `${u.name} ${u.login}`.toLowerCase().includes(uq.trim().toLowerCase()))), [users.data, status, uq]);
  const nActive = users.data?.items.filter(u => u.active).length ?? 0;
  const nAll = users.data?.items.length ?? 0;

  /* ---------------- user groups ---------------- */
  const groups = useQuery({ queryKey: ['um-groups'], queryFn: api.userGroups });
  const [gid, setGid] = useState<number | 'new' | null>(null);
  const gdetail = useQuery({ queryKey: ['um-group', gid, lang], queryFn: () => api.userGroup(gid as number, lang), enabled: typeof gid === 'number' });
  const [gname, setGname] = useState(''); const [gbase, setGbase] = useState('');
  const [gq, setGq] = useState('');
  const [gdlg, setGdlg] = useState<null | 'right' | 'user' | 'del'>(null);
  const [pendingG, setPendingG] = useState<number | 'new' | null | undefined>(undefined);
  useEffect(() => {
    if (gid === 'new') { setGname(''); setGbase(''); } else if (gdetail.data) { setGname(gdetail.data.name); setGbase(gdetail.data.name); }
  }, [gid, gdetail.data?.id, gdetail.data?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  const gdirty = gid !== null && gname !== gbase;
  const openGroup = (id: number | 'new' | null) => { if (gdirty && id !== gid) setPendingG(id); else setGid(id); };
  const saveGroup = () => run(async () => {
    if (!gname.trim()) throw new Error('Please enter a group name.');
    if (gid === 'new') { const r = await api.createUserGroup(gname); await refresh(); setGbase(gname); setGid(r.id); }
    else if (typeof gid === 'number') { await api.renameUserGroup(gid, gname); await refresh(); setGbase(gname); }
    setMsg({ ok: true, t: 'User group saved.' });
  });
  const glist = (groups.data ?? []).filter(g => !gq.trim() || g.name.toLowerCase().includes(gq.trim().toLowerCase()));
  useSaveShortcut(() => { if (busy) return; if (tab === 'user' && dirty) void saveUser(); else if (tab === 'group' && gdirty) void saveGroup(); }, true);

  const pickerUsers: IdLabel[] = (allUsers.data?.items ?? []).map(u => ({ id: u.idAcc, name: `${u.name}[${u.login}]` }));
  const pickerGroups: IdLabel[] = groups.data ?? [];
  if (users.error) return <div className="card" style={{ padding: 20 }}><div className="alert" role="alert">{(users.error as Error).message}</div></div>;

  const askRemove = (title: string, text: React.ReactNode, fn: () => Promise<void>) => setRm({ title, text, fn });

  return (
    <div className="um">
      <PageHero icon={<IconUsers />} title="User management" sub="Users, user groups and their rights"
        chips={[{ n: users.data ? nActive : '–', label: 'active' }, { n: users.data ? nAll : '–', label: 'users' }, { n: groups.data?.length ?? '–', label: 'groups' }]} />
      <div className="um-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'user'} className={tab === 'user' ? 'on' : ''} onClick={() => { setTab('user'); setMsg(null); }}>👤 Users</button>
        <button role="tab" aria-selected={tab === 'group'} className={tab === 'group' ? 'on' : ''} onClick={() => { setTab('group'); setMsg(null); }}>👥 User Groups</button>
      </div>

      {tab === 'user' && (
        <div className="fx">
          <aside className="card fx-list">
            <button className="fx-new" onClick={() => openUser('new')}><span>＋</span> New user</button>
            <div className="fx-search"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg><input value={uq} onChange={e => setUq(e.target.value)} placeholder="Search name or login" aria-label="Search users" /></div>
            <div className="fx-seg" role="tablist">
              {([['all', 'All', nAll], ['active', 'Active', nActive], ['inactive', 'Inactive', nAll - nActive]] as ['all' | 'active' | 'inactive', string, number][]).map(([k, l, n]) =>
                <button key={k} role="tab" aria-selected={status === k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>{l}<em>{n}</em></button>)}
            </div>
            <div className="fx-items">
              {users.isLoading && <PageLoader compact label="Loading users" />}
              {ulist.map(u => (
                <button key={u.idAcc} className={`fx-item ${uid === u.idAcc ? 'sel' : ''} ${u.active ? '' : 'inactive'}`} onClick={() => openUser(u.idAcc)}>
                  <span className="um-av" style={{ background: avColor(u.name) }}>{initials(u.name)}</span>
                  <span className="tx"><b>{u.name}</b><small>{u.login}</small></span>
                  <i className={`um-dot ${u.active ? 'on' : ''}`} title={u.active ? 'Active' : 'Inactive'} />
                </button>
              ))}
              {users.data && ulist.length === 0 && <div className="fx-empty">No users match.</div>}
            </div>
          </aside>

          <section className="card fx-edit">
            {uid === null ? (
              <div className="fx-hero"><div className="big">🧑‍💼</div><h3>Select a user or add a new one</h3>
                <p>Manage logins, rights and user groups. Rights can also be copied from another user.</p>
                <button className="btn-primary" onClick={() => openUser('new')}>＋ New user</button></div>
            ) : (<>
              <div className="fx-head">
                <div className="fx-who">
                  <span className="um-av big" style={{ background: avColor(f.name || '?') }}>{initials(f.name || '?')}</span>
                  <div className="who-t"><h3>{isNew ? 'New user' : (f.name || 'User')}</h3>
                    <div className="tags">
                      <span className={`um-badge ${f.active ? 'on' : ''}`}>{f.active ? 'Active' : 'Inactive'}</span>
                      {f.processOwner && <span className="fx-tag">Process owner</span>}
                      {f.ntAuth && <span className="fx-tag">Windows login</span>}
                      {sync && <span className="fx-tag">Synchronised</span>}
                      {cur?.head.lastLogin && !isNew && <small className="mh">Last login {new Date(cur.head.lastLogin).toLocaleString()}</small>}
                    </div></div>
                </div>
                {!isNew && (
                  <div className="fx-tools">
                    <button className="btn-ghost" disabled={busy} onClick={() => { setPwdErr(null); setDlg('pwd'); }}>🔑 Change password</button>
                    <button className="btn-ghost" disabled={busy} onClick={() => setDlg('all')}>🛡 All rights</button>
                    <button className="btn-ghost" disabled={busy} onClick={() => setDlg('copy')}>📋 Copy rights from…</button>
                    <button className="btn-ghost" disabled={busy || !f.active} onClick={simulate} title="Work as this user (right Simulation)">🎭 Simulate</button>
                    <button className="btn-ghost" disabled={busy} onClick={() => run(async () => { await downloadUserRights(lang); setMsg({ ok: true, t: 'Rights overview exported (MS-LDS-User-Rights.csv).' }); })}>⬇ Export rights</button>
                  </div>)}
              </div>

              <div className="fx-pane">
                <div className="fx-grid2">
                  <div className="fx-field"><div className="fx-lbl">User name<span className="fx-lbl-tools"><em>{f.name.length}/50</em></span></div>
                    <input className="fx-in" value={f.name} maxLength={50} aria-invalid={!!errName} onChange={e => set({ name: e.target.value })} onBlur={() => setTouched(true)} />
                    {errName && <div className="fx-err">{errName}</div>}</div>
                  <div className="fx-field"><div className="fx-lbl">Login name<span className="fx-lbl-tools"><em>{f.login.length}/30</em></span></div>
                    <input className="fx-in" value={f.login} maxLength={30} autoComplete="off" aria-invalid={!!errLogin} onChange={e => set({ login: e.target.value })} onBlur={() => setTouched(true)} />
                    {errLogin && <div className="fx-err">{errLogin}</div>}</div>
                  <div className="fx-field"><div className="fx-lbl">E-mail</div>
                    <div className="fx-mail"><input className="fx-in" type="email" value={f.email} maxLength={100} aria-invalid={!!errMail} onChange={e => set({ email: e.target.value })} />
                      <a className="btn-ghost" href={f.email && !errMail ? `mailto:${f.email}` : undefined} aria-disabled={!f.email || !!errMail} title="Write an e-mail">✉</a></div>
                    {errMail && <div className="fx-err">{errMail}</div>}</div>
                </div>
                <div className="fx-switches col">
                  <Switch checked={f.active} disabled={sync} onChange={v => set({ active: v })} label="Active" desc={sync ? 'Managed by the directory synchronisation.' : 'Only active users can log in. A new user needs a password first.'} />
                  <Switch checked={f.processOwner} onChange={v => set({ processOwner: v })} label="Process owner" desc="Can be chosen as process owner of documents." />
                  <Switch checked={f.ntAuth} onChange={v => set({ ntAuth: v })} label="Windows (NT) authentication" desc="Log in with the Windows account instead of a password." />
                </div>

                {!isNew && cur && (
                  <div className="fx-two">
                    <Panel title="User rights" icon="🛡" items={cur.rights} busy={busy} empty="No own rights yet." onAdd={() => setDlg('right')}
                      onRemove={id => { const r = cur.rights.find(x => x.id === id); if (r) askRemove('Remove right?', <>The right <b>{r.name}</b> will be removed from <b>{f.name}</b>.</>, async () => { await api.delUserRight(uid as number, r.id); await refresh(); setMsg({ ok: true, t: `Right "${r.name}" removed.` }); }); }} />
                    <Panel title="User groups" icon="👥" items={cur.groups} busy={busy} empty="Not in any user group." onAdd={() => setDlg('group')}
                      onRemove={id => { const g = cur.groups.find(x => x.id === id); if (g) askRemove('Remove from group?', <><b>{f.name}</b> will be removed from the user group <b>{g.name}</b>.</>, async () => { await api.delUserFromGroup(uid as number, g.id); await refresh(); setMsg({ ok: true, t: `Removed from group "${g.name}".` }); }); }} />
                  </div>
                )}
                {isNew && <div className="fx-hint">After saving, rights and user groups can be assigned. A new user is always inactive until a password has been set and the user is activated.</div>}
              </div>

              <SaveBar dirty={dirty} busy={busy} canSave={!!f.name.trim() && !!f.login.trim() && !errMail} onSave={() => void saveUser()} onReset={resetU}>
                {!isNew && <button className="btn-ghost danger" disabled={busy || sync} onClick={() => setDlg('del')} title={sync ? 'Synchronised users cannot be deleted' : 'Delete user'}>Delete</button>}
                <button className="btn-ghost" onClick={() => nav('/documents')}>Close</button>
              </SaveBar>
            </>)}
          </section>
        </div>
      )}

      {tab === 'group' && (
        <div className="fx">
          <aside className="card fx-list">
            <button className="fx-new" onClick={() => openGroup('new')}><span>＋</span> New user group</button>
            <div className="fx-search"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg><input value={gq} onChange={e => setGq(e.target.value)} placeholder="Search groups" aria-label="Search groups" /></div>
            <div className="fx-items">
              {groups.isLoading && <PageLoader compact label="Loading groups" />}
              {glist.map(g => (
                <button key={g.id} className={`fx-item ${gid === g.id ? 'sel' : ''}`} onClick={() => openGroup(g.id)}>
                  <span className="um-av grp">{initials(g.name)}</span><span className="tx"><b>{g.name}</b></span></button>))}
              {groups.data && glist.length === 0 && <div className="fx-empty">No user groups.</div>}
            </div>
          </aside>
          <section className="card fx-edit">
            {gid === null ? (
              <div className="fx-hero"><div className="big">👥</div><h3>Select a user group or add a new one</h3>
                <p>Rights given to a group apply to every member of that group.</p>
                <button className="btn-primary" onClick={() => openGroup('new')}>＋ New user group</button></div>
            ) : (<>
              <div className="fx-head"><div className="fx-namebox">
                <input value={gname} maxLength={50} placeholder="Group name…" aria-label="Group name" onChange={e => setGname(e.target.value)} onKeyDown={e => e.key === 'Enter' && gname.trim() && void saveGroup()} autoFocus={gid === 'new'} />
                {typeof gid === 'number' && gdetail.data && <div className="fx-count"><b>{gdetail.data.users.length}</b><span>member{gdetail.data.users.length === 1 ? '' : 's'}</span></div>}
              </div></div>
              <div className="fx-pane">
                {typeof gid === 'number' && gdetail.data ? (
                  <div className="fx-two">
                    <Panel title="Group rights" icon="🛡" items={gdetail.data.rights} busy={busy} empty="No rights yet." onAdd={() => setGdlg('right')}
                      onRemove={id => { const r = gdetail.data!.rights.find(x => x.id === id); if (r) askRemove('Remove right?', <>The right <b>{r.name}</b> will be removed from the group <b>{gname}</b>.</>, async () => { await api.delGroupRight(gid, r.id); await refresh(); setMsg({ ok: true, t: `Right "${r.name}" removed from the group.` }); }); }} />
                    <Panel title="Group users" icon="👤" avatar items={gdetail.data.users} busy={busy} empty="No users in this group." onAdd={() => setGdlg('user')}
                      onRemove={id => { const u = gdetail.data!.users.find(x => x.id === id); if (u) askRemove('Remove user from group?', <><b>{u.name}</b> will be removed from the group <b>{gname}</b>.</>, async () => { await api.delGroupUser(gid, u.id); await refresh(); setMsg({ ok: true, t: `${u.name} removed from the group.` }); }); }} />
                  </div>
                ) : gid === 'new' ? <div className="fx-hint">Save the group first, then add rights and users.</div> : <PageLoader compact label="Loading group" />}
              </div>
              <SaveBar dirty={gdirty} busy={busy} canSave={!!gname.trim()} onSave={() => void saveGroup()} onReset={() => setGname(gbase)}>
                {typeof gid === 'number' && <button className="btn-ghost danger" disabled={busy} onClick={() => setGdlg('del')}>Delete</button>}
                <button className="btn-ghost" onClick={() => nav('/documents')}>Close</button>
              </SaveBar>
            </>)}
          </section>
        </div>
      )}

      <Toast msg={msg} onClose={() => setMsg(null)} />

      {/* ---- dialogs ---- */}
      {pendingU !== undefined && <ConfirmDialog title="Discard your changes?" confirmLabel="Discard" busy={false}
        message={<>You changed <b>{f.name || 'this user'}</b> and did not save it.</>} onConfirm={() => { setTouched(false); setUid(pendingU); setPendingU(undefined); }} onCancel={() => setPendingU(undefined)} />}
      {pendingG !== undefined && <ConfirmDialog title="Discard your changes?" confirmLabel="Discard" busy={false}
        message={<>You changed the group name and did not save it.</>} onConfirm={() => { setGid(pendingG); setPendingG(undefined); }} onCancel={() => setPendingG(undefined)} />}
      {rm && <ConfirmDialog danger title={rm.title} confirmLabel="Remove" busy={busy} message={rm.text}
        onConfirm={async () => { await run(rm.fn); setRm(null); }} onCancel={() => setRm(null)} />}
      {dlg === 'right' && typeof uid === 'number' && <RightPicker lang={lang} legend="User Rights" taken={(cur?.rights ?? []).filter(r => r.rcod !== 21).map(r => r.rcod)} busy={busy} onCancel={() => setDlg(null)}
        onOk={(c, v) => run(async () => { await api.addUserRight(uid, c, v); await refresh(); setDlg(null); setMsg({ ok: true, t: 'Right added.' }); })} />}
      {dlg === 'group' && typeof uid === 'number' && <Pick title="Choose Groups" legend="User Groups" busy={busy} onCancel={() => setDlg(null)}
        items={pickerGroups.filter(g => !cur?.groups.some(x => x.id === g.id))}
        onOk={id => run(async () => { await api.addUserToGroup(uid, id); await refresh(); setDlg(null); setMsg({ ok: true, t: 'User added to the group.' }); })} />}
      {dlg === 'copy' && typeof uid === 'number' && <Pick title="Copy From" legend="Copy the rights and user groups of this user" busy={busy} onCancel={() => setDlg(null)}
        items={pickerUsers.filter(u => u.id !== uid)}
        onOk={id => run(async () => { const r = await api.copyUserFrom(uid, id); await refresh(); setDlg(null); setMsg({ ok: true, t: `Copied ${r.rightsAdded} right(s) and ${r.groupsAdded} group membership(s).` }); })} />}
      {dlg === 'all' && typeof uid === 'number' && <AllRightsDialog id={uid} lang={lang} name={f.name} onClose={() => setDlg(null)} />}
      {dlg === 'pwd' && typeof uid === 'number' && <PasswordDialog busy={busy} error={pwdErr} onCancel={() => setDlg(null)}
        onOk={async p => { setBusy(true); setPwdErr(null); try { await api.setUserPassword(uid, p); setDlg(null); setMsg({ ok: true, t: 'Password changed.' }); } catch (e) { setPwdErr((e as Error).message); } finally { setBusy(false); } }} />}
      {dlg === 'del' && typeof uid === 'number' && <ConfirmDialog danger title="Delete user?" confirmLabel="Delete" busy={busy}
        message={<>The user <b>{f.name}</b> will be deactivated and removed from all user groups; all rights are removed. Documents and history keep the name.</>}
        onConfirm={async () => { await run(async () => { await api.deleteUser(uid); await refresh(); setUid(null); setMsg({ ok: true, t: 'User deleted.' }); }); setDlg(null); }} onCancel={() => setDlg(null)} />}

      {gdlg === 'right' && typeof gid === 'number' && <RightPicker lang={lang} legend="Group Rights" taken={(gdetail.data?.rights ?? []).filter(r => r.rcod !== 21).map(r => r.rcod)} busy={busy} onCancel={() => setGdlg(null)}
        onOk={(c, v) => run(async () => { await api.addGroupRight(gid, c, v); await refresh(); setGdlg(null); setMsg({ ok: true, t: 'Right added to the group.' }); })} />}
      {gdlg === 'user' && typeof gid === 'number' && <Pick title="Choose Users" legend="Group Users" busy={busy} onCancel={() => setGdlg(null)}
        items={pickerUsers.filter(u => !gdetail.data?.users.some(x => x.id === u.id))}
        onOk={id => run(async () => { await api.addGroupUser(gid, id); await refresh(); setGdlg(null); setMsg({ ok: true, t: 'User added to the group.' }); })} />}
      {gdlg === 'del' && typeof gid === 'number' && <ConfirmDialog danger title="Delete user group?" confirmLabel="Delete" busy={busy}
        message={<>The user group <b>{gname}</b> will be removed together with its rights. Its members lose the rights they got through this group.</>}
        onConfirm={async () => { await run(async () => { await api.deleteUserGroup(gid); await refresh(); setGid(null); setMsg({ ok: true, t: 'User group deleted.' }); }); setGdlg(null); }} onCancel={() => setGdlg(null)} />}
    </div>
  );
}


function AllRightsDialog({ id, lang, name, onClose }: { id: number; lang: string; name: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['um-user-all', id, lang], queryFn: () => api.userAllRights(id, lang) });
  return (
    <div className="modal-back" style={{ zIndex: 90 }} onMouseDown={onClose}>
      <div className="modal um-pick" role="dialog" aria-modal="true" aria-label="All rights" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head"><b>All rights of {name}</b></div>
        <div className="um-pick-body">
          <div className="um-legend">Own rights plus the rights of all user groups</div>
          <div className="um-list">
            {q.isLoading && <PageLoader compact label="Loading rights" />}
            {q.data?.rights.map(r => <div key={`${r.id}-${r.rcod}-${r.rvalue}`} className="um-item">{r.name}</div>)}
            {q.data?.rights.length === 0 && <div className="mh" style={{ padding: 8 }}>No rights.</div>}
          </div>
        </div>
        <div className="modal-foot"><button className="btn-primary" onClick={onClose}>OK</button></div>
      </div>
    </div>
  );
}
