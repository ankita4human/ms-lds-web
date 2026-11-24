import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, simulation, downloadUserRights, type IdLabel, type RightItem } from './api';
import { useLang } from './LangContext';
import { Spinner, PageLoader } from './components/Loader';
import ConfirmDialog from './components/ConfirmDialog';
import Toast from './components/Toast';
import { IconUsers } from './components/Icons';

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
  const local = a && b && a !== b ? 'The two entries are not identical.' : null;
  return (
    <div className="modal-back" style={{ zIndex: 90 }} onMouseDown={() => !busy && onCancel()}>
      <div className="modal um-pick" role="dialog" aria-modal="true" aria-label="Change password" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head"><b>Change password</b></div>
        <div className="um-pick-body">
          <label className="fm-row">New password<input type={show ? 'text' : 'password'} value={a} onChange={e => setA(e.target.value)} autoFocus autoComplete="new-password" /></label>
          <label className="fm-row">Repeat<input type={show ? 'text' : 'password'} value={b} onChange={e => setB(e.target.value)} autoComplete="new-password" /></label>
          <label className="fm-chk"><input type="checkbox" checked={show} onChange={e => setShow(e.target.checked)} />Show password</label>
          <small className="mh">At least 8 characters with letters, numbers and special characters.</small>
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
const Plus = ({ onClick, disabled, label }: { onClick: () => void; disabled?: boolean; label: string }) => <button className="ico-btn add" title={label} aria-label={label} onClick={onClick} disabled={disabled}>＋</button>;
const Minus = ({ onClick, disabled, label }: { onClick: () => void; disabled?: boolean; label: string }) => <button className="ico-btn del" title={label} aria-label={label} onClick={onClick} disabled={disabled}>−</button>;
const List = ({ items, sel, setSel }: { items: { id: number; name: string }[]; sel: number | null; setSel: (n: number) => void }) => (
  <div className="um-list tall">{items.map(i => <div key={i.id} className={`um-item ${sel === i.id ? 'sel' : ''}`} onClick={() => setSel(i.id)}>{i.name}</div>)}</div>);

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
  const users = useQuery({ queryKey: ['um-users', status], queryFn: () => api.users(status) });
  const allUsers = useQuery({ queryKey: ['um-users', 'all'], queryFn: () => api.users('all') });
  const [uid, setUid] = useState<number | 'new' | null>(null);
  const detail = useQuery({ queryKey: ['um-user', uid, lang], queryFn: () => api.user(uid as number, lang), enabled: typeof uid === 'number' });
  const [f, setF] = useState({ name: '', login: '', email: '', active: false, ntAuth: false, processOwner: false });
  const [dlg, setDlg] = useState<null | 'right' | 'group' | 'copy' | 'pwd' | 'del' | 'all'>(null);
  const [rm, setRm] = useState<null | { title: string; text: React.ReactNode; fn: () => Promise<void> }>(null);
  const [pwdErr, setPwdErr] = useState<string | null>(null);
  const [selRight, setSelRight] = useState<number | null>(null);
  const [selGrp, setSelGrp] = useState<number | null>(null);

  useEffect(() => {
    if (uid === 'new') { setF({ name: '', login: '', email: '', active: false, ntAuth: false, processOwner: false }); setMsg(null); return; }
    const h = detail.data?.head; if (h) { setF({ name: h.name, login: h.login, email: h.email, active: h.active, ntAuth: h.ntAuth, processOwner: h.processOwner }); setMsg(null); }
  }, [uid, detail.data?.head?.idAcc]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setSelRight(null); setSelGrp(null); }, [uid]);

  const saveUser = () => run(async () => {
    const r = uid === 'new' ? await api.createUser(f) : await api.updateUser(uid as number, f);
    await refresh(); setUid(r.idAcc);
    setMsg({ ok: true, t: uid === 'new' ? 'User created (inactive). Set a password, assign rights and activate the user.' : 'User saved.' });
  });
  const simulate = () => run(async () => { const r = await api.simulateUser(uid as number); simulation.start(r.token, r.login); location.assign('/documents'); });

  const cur = detail.data;
  const isNew = uid === 'new';
  const sync = cur?.head.isSync ?? false;

  /* ---------------- user groups ---------------- */
  const groups = useQuery({ queryKey: ['um-groups'], queryFn: api.userGroups });
  const [gid, setGid] = useState<number | 'new' | null>(null);
  const gdetail = useQuery({ queryKey: ['um-group', gid, lang], queryFn: () => api.userGroup(gid as number, lang), enabled: typeof gid === 'number' });
  const [gname, setGname] = useState('');
  const [gdlg, setGdlg] = useState<null | 'right' | 'user' | 'del'>(null);
  const [gSelRight, setGSelRight] = useState<number | null>(null);
  const [gSelUser, setGSelUser] = useState<number | null>(null);
  useEffect(() => { if (gid === 'new') setGname(''); else if (gdetail.data) setGname(gdetail.data.name); }, [gid, gdetail.data?.id, gdetail.data?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setGSelRight(null); setGSelUser(null); }, [gid]);
  const saveGroup = () => run(async () => {
    if (gid === 'new') { const r = await api.createUserGroup(gname); await refresh(); setGid(r.id); }
    else if (typeof gid === 'number') { await api.renameUserGroup(gid, gname); await refresh(); }
    setMsg({ ok: true, t: 'User group saved.' });
  });

  const pickerUsers: IdLabel[] = (allUsers.data?.items ?? []).map(u => ({ id: u.idAcc, name: `${u.name}[${u.login}]` }));
  const pickerGroups: IdLabel[] = groups.data ?? [];
  if (users.error) return <div className="card" style={{ padding: 20 }}><div className="alert" role="alert">{(users.error as Error).message}</div></div>;

  return (
    <div className="um">
      <div className="um-hero">
        <div className="um-hero-ico"><IconUsers /></div>
        <div className="um-hero-txt"><h2>User management</h2><p>Users, user groups and their rights</p></div>
        <div className="um-chips">
          <span className="um-chip"><b>{allUsers.data?.activeCount ?? '–'}</b>active</span>
          <span className="um-chip"><b>{allUsers.data?.total ?? '–'}</b>users</span>
          <span className="um-chip"><b>{groups.data?.length ?? '–'}</b>groups</span>
        </div>
      </div>
      <div className="um-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'user'} className={tab === 'user' ? 'on' : ''} onClick={() => { setTab('user'); setMsg(null); }}>User</button>
        <button role="tab" aria-selected={tab === 'group'} className={tab === 'group' ? 'on' : ''} onClick={() => { setTab('group'); setMsg(null); }}>User Groups</button>
      </div>

      {tab === 'user' && (
        <div className="fm">
          <div className="card fm-list">
            <fieldset className="fm-box"><legend>All users</legend>
              <div className="um-head">
                <label className="um-search-l">Search <select value={status} onChange={e => setStatus(e.target.value as typeof status)}>
                  <option value="all">All</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
                <span><Plus label="Add new user" onClick={() => setUid('new')} />
                  <Minus label="Delete user" disabled={busy || typeof uid !== 'number' || sync} onClick={() => setDlg('del')} /></span>
              </div>
              {users.isLoading && <PageLoader compact label="Loading users" />}
              <div className="um-list users">
                {users.data?.items.map(u => (
                  <div key={u.idAcc} className={`um-item ${uid === u.idAcc ? 'sel' : ''} ${u.active ? '' : 'off'}`} onClick={() => setUid(u.idAcc)}>
                    <span className="um-av" style={{ background: avColor(u.name) }}>{initials(u.name)}</span>
                    <span className="um-nm"><b>{u.name}</b><small>[{u.login}]</small></span>
                    <i className={`um-dot ${u.active ? 'on' : ''}`} title={u.active ? 'Active' : 'Inactive'} />
                  </div>
                ))}
                {users.data && users.data.items.length === 0 && <div className="mh" style={{ padding: 10 }}>No users.</div>}
              </div>
            </fieldset>
          </div>

          <div className="card fm-edit">
            {uid === null ? <div className="mh" style={{ padding: 20 }}>Select a user on the left or add a new one.</div> : (<>
              {!isNew && <div className="um-who"><span className="um-av big" style={{ background: avColor(f.name || '?') }}>{initials(f.name || '?')}</span>
                <div><h3>{f.name}</h3><small>{f.login}{f.email ? ` · ${f.email}` : ''}</small></div>
                <span className={`um-badge ${f.active ? 'on' : ''}`}>{f.active ? 'Active' : 'Inactive'}</span></div>}
              <fieldset className="fm-box"><legend>User Properties</legend>
                <div className="um-props">
                  <div className="fm-fields">
                    <label className="fm-row">User Name<input value={f.name} maxLength={50} onChange={e => setF({ ...f, name: e.target.value })} /></label>
                    <label className="fm-row">Login Name<input value={f.login} maxLength={30} onChange={e => setF({ ...f, login: e.target.value })} autoComplete="off" /></label>
                    <label className="fm-row">Email<span className="um-mail"><input type="email" value={f.email} maxLength={100} onChange={e => setF({ ...f, email: e.target.value })} />
                      <a className="btn-ghost" href={f.email ? `mailto:${f.email}` : undefined} aria-disabled={!f.email} title="Write an e-mail">✉</a></span></label>
                    <div className="um-checks">
                      <label className="fm-chk"><input type="checkbox" checked={f.active} disabled={sync} onChange={e => setF({ ...f, active: e.target.checked })} />Active</label>
                      <label className="fm-chk"><input type="checkbox" checked={f.processOwner} onChange={e => setF({ ...f, processOwner: e.target.checked })} />Process Owner</label>
                      <label className="fm-chk"><input type="checkbox" checked={f.ntAuth} onChange={e => setF({ ...f, ntAuth: e.target.checked })} />NTAuthent</label>
                      <span><button className="btn-ghost" disabled={busy} onClick={() => run(async () => { await downloadUserRights(lang); setMsg({ ok: true, t: 'Rights overview exported (MS-LDS-User-Rights.csv).' }); })}>Export Rights</button></span>
                    </div>
                    {cur?.head.lastLogin && !isNew && <small className="mh">Last login: {new Date(cur.head.lastLogin).toLocaleString()}</small>}
                  </div>
                  <div className="fm-btns">
                    <button className="btn-primary" onClick={saveUser} disabled={busy}>{busy ? <Spinner /> : 'Save'}</button>
                    <button className="btn-ghost" disabled={busy || isNew} onClick={() => { setPwdErr(null); setDlg('pwd'); }}>Change Pwd</button>
                    <button className="btn-ghost" disabled={busy || isNew} onClick={() => setDlg('all')}>All rights</button>
                    <button className="btn-ghost" disabled={busy || isNew || !f.active} onClick={simulate} title="Work as this user (right Simulation)">Simulate</button>
                    <button className="btn-ghost" disabled={busy || isNew} onClick={() => setDlg('copy')}>Copy From</button>
                  </div>
                </div>
              </fieldset>
              {!isNew && cur && (
                <div className="um-two">
                  <fieldset className="fm-box"><legend>User Rights</legend>
                    <div className="um-head"><span /><span><Plus label="Add right" disabled={busy} onClick={() => setDlg('right')} />
                      <Minus label="Remove right" disabled={busy || selRight === null} onClick={() => { const r = cur.rights.find(x => x.id === selRight); if (r) setRm({ title: 'Remove right?', text: <>The right <b>{r.name}</b> will be removed from <b>{f.name}</b>.</>, fn: async () => { await api.delUserRight(uid as number, r.id); setSelRight(null); await refresh(); setMsg({ ok: true, t: `Right "${r.name}" removed.` }); } }); }} /></span></div>
                    <List items={cur.rights} sel={selRight} setSel={setSelRight} />
                  </fieldset>
                  <fieldset className="fm-box"><legend>User Groups</legend>
                    <div className="um-head"><span /><span><Plus label="Add to group" disabled={busy} onClick={() => setDlg('group')} />
                      <Minus label="Remove from group" disabled={busy || selGrp === null} onClick={() => { const g = cur.groups.find(x => x.id === selGrp); if (g) setRm({ title: 'Remove from group?', text: <><b>{f.name}</b> will be removed from the user group <b>{g.name}</b>.</>, fn: async () => { await api.delUserFromGroup(uid as number, g.id); setSelGrp(null); await refresh(); setMsg({ ok: true, t: `Removed from group "${g.name}".` }); } }); }} /></span></div>
                    <List items={cur.groups} sel={selGrp} setSel={setSelGrp} />
                  </fieldset>
                </div>
              )}
              {isNew && <small className="mh">After saving, rights and user groups can be assigned. A new user is always inactive until a password has been set and the user is activated.</small>}
            </>)}
          </div>
        </div>
      )}

      {tab === 'group' && (
        <div className="fm">
          <div className="card fm-list">
            <fieldset className="fm-box"><legend>All User Groups</legend>
              <div className="um-head"><span /><span><Plus label="Add new user group" onClick={() => setGid('new')} />
                <Minus label="Delete user group" disabled={busy || typeof gid !== 'number'} onClick={() => setGdlg('del')} /></span></div>
              {groups.isLoading && <PageLoader compact label="Loading groups" />}
              <div className="um-list users">
                {groups.data?.map(g => <div key={g.id} className={`um-item ${gid === g.id ? 'sel' : ''}`} onClick={() => setGid(g.id)}><span className="um-av grp">{initials(g.name)}</span><span className="um-nm"><b>{g.name}</b></span></div>)}
              </div>
            </fieldset>
          </div>
          <div className="card fm-edit">
            {gid === null ? <div className="mh" style={{ padding: 20 }}>Select a user group on the left or add a new one.</div> : (<>
              <fieldset className="fm-box"><legend>User Group Properties</legend>
                <div className="fm-top">
                  <div className="fm-fields"><label className="fm-row">New group<input value={gname} maxLength={50} onChange={e => setGname(e.target.value)} /></label></div>
                  <div className="fm-btns"><button className="btn-primary" onClick={saveGroup} disabled={busy}>{busy ? <Spinner /> : 'Save'}</button></div>
                </div>
              </fieldset>
              {typeof gid === 'number' && gdetail.data && (
                <div className="um-two">
                  <fieldset className="fm-box"><legend>Group Rights</legend>
                    <div className="um-head"><span /><span><Plus label="Add right" disabled={busy} onClick={() => setGdlg('right')} />
                      <Minus label="Remove right" disabled={busy || gSelRight === null} onClick={() => { const r = gdetail.data!.rights.find(x => x.id === gSelRight); if (r) setRm({ title: 'Remove right?', text: <>The right <b>{r.name}</b> will be removed from the group <b>{gname}</b>.</>, fn: async () => { await api.delGroupRight(gid, r.id); setGSelRight(null); await refresh(); setMsg({ ok: true, t: `Right "${r.name}" removed from the group.` }); } }); }} /></span></div>
                    <List items={gdetail.data.rights} sel={gSelRight} setSel={setGSelRight} />
                  </fieldset>
                  <fieldset className="fm-box"><legend>Group Users</legend>
                    <div className="um-head"><span /><span><Plus label="Add user" disabled={busy} onClick={() => setGdlg('user')} />
                      <Minus label="Remove user" disabled={busy || gSelUser === null} onClick={() => { const u = gdetail.data!.users.find(x => x.id === gSelUser); if (u) setRm({ title: 'Remove user from group?', text: <><b>{u.name}</b> will be removed from the group <b>{gname}</b>.</>, fn: async () => { await api.delGroupUser(gid, u.id); setGSelUser(null); await refresh(); setMsg({ ok: true, t: `${u.name} removed from the group.` }); } }); }} /></span></div>
                    <List items={gdetail.data.users} sel={gSelUser} setSel={setGSelUser} />
                  </fieldset>
                </div>
              )}
              {gid === 'new' && <small className="mh">Save the group first, then add rights and users.</small>}
            </>)}
          </div>
        </div>
      )}

      <div className="um-status">
        <span className="um-count"><b>{users.data?.activeCount ?? allUsers.data?.activeCount ?? '–'}</b> active users</span>
        <button className="um-ok" onClick={() => nav('/documents')}>OK</button>
      </div>
      <Toast msg={msg} onClose={() => setMsg(null)} />

      {/* ---- dialogs ---- */}
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
