import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, type MailMember } from './api';
import { Spinner, PageLoader } from './components/Loader';
import ConfirmDialog from './components/ConfirmDialog';
import Toast, { type ToastMsg } from './components/Toast';
import PageHero from './components/PageHero';
import { IconMail } from './components/Icons';

const initials = (n: string) => n.split(/[\s.@]+/).filter(Boolean).slice(0, 2).map(x => x[0]!.toUpperCase()).join('') || '?';
const avColor = (n: string) => { let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360; return `linear-gradient(135deg, hsl(${h} 70% 52%), hsl(${(h + 40) % 360} 75% 42%))`; };

/** "MS LDS Address Book" (manual p. 61): pick one or many addresses, add a new address, edit or delete addresses that are not users. */
function AddressBook({ exclude, busy, onAdd, onCancel, onMsg }: { exclude: number[]; busy: boolean; onAdd: (ids: number[]) => void; onCancel: () => void; onMsg: (m: ToastMsg) => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['mail-contacts'], queryFn: api.mailContacts });
  const [search, setSearch] = useState('');
  const [sel, setSel] = useState<number[]>([]);
  const [form, setForm] = useState<null | { idec: number | null; name: string; email: string }>(null);
  const [formErr, setFormErr] = useState('');
  const [fb, setFb] = useState(false);
  const [del, setDel] = useState<MailMember | null>(null);
  const shown = useMemo(() => (q.data ?? []).filter(c => !exclude.includes(c.idec) && `${c.name} ${c.email}`.toLowerCase().includes(search.toLowerCase())), [q.data, exclude, search]);
  const toggle = (id: number) => setSel(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);

  async function saveForm() {
    if (!form) return; setFb(true); setFormErr('');
    try {
      if (form.idec === null) {
        const r = await api.addMailContact(form.name, form.email);
        await qc.invalidateQueries({ queryKey: ['mail-contacts'] });
        if (!exclude.includes(r.idec)) setSel(s => s.includes(r.idec) ? s : [...s, r.idec]);
        onMsg({ ok: true, t: r.existed ? 'This e-mail address already exists in the address book; it has been selected.' : 'E-mail address added to the address book.' });
      } else {
        await api.changeMailContact(form.idec, form.name, form.email);
        await qc.invalidateQueries({ queryKey: ['mail-contacts'] }); await qc.invalidateQueries({ queryKey: ['mail-list'] });
        onMsg({ ok: true, t: 'E-mail address changed.' });
      }
      setForm(null);
    } catch (e) { setFormErr((e as Error).message); } finally { setFb(false); }
  }
  async function remove(c: MailMember) {
    setFb(true);
    try { await api.deleteMailContact(c.idec); setSel(s => s.filter(x => x !== c.idec)); await qc.invalidateQueries({ queryKey: ['mail-contacts'] }); await qc.invalidateQueries({ queryKey: ['mail-list'] }); await qc.invalidateQueries({ queryKey: ['mail-lists'] }); onMsg({ ok: true, t: `Address ${c.email} deleted.` }); }
    catch (e) { onMsg({ ok: false, t: (e as Error).message }); } finally { setFb(false); setDel(null); }
  }

  return (
    <div className="modal-back" style={{ zIndex: 90 }} onMouseDown={() => !busy && onCancel()}>
      <div className="modal um-pick ab" role="dialog" aria-modal="true" aria-label="Address book" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head"><b>MS LDS Address Book</b></div>
        <div className="um-pick-body">
          <div className="ab-bar">
            <input placeholder="Search name or e-mail…" value={search} onChange={e => setSearch(e.target.value)} autoFocus />
            <button className="btn-ghost" onClick={() => { setForm({ idec: null, name: '', email: '' }); setFormErr(''); }}>＋ New address</button>
          </div>
          {form && (
            <div className="ab-form">
              <b>{form.idec === null ? 'Add e-mail address' : 'Change e-mail address'}</b>
              <label className="fm-row">Name<input value={form.name} maxLength={50} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
              <label className="fm-row">E-mail<input type="email" value={form.email} maxLength={100} onChange={e => setForm({ ...form, email: e.target.value })} /></label>
              {formErr && <div className="alert" role="alert">{formErr}</div>}
              <div className="um-btns"><button className="btn-ghost" onClick={() => setForm(null)} disabled={fb}>Cancel</button>
                <button className="btn-primary" style={{ width: 'auto' }} onClick={saveForm} disabled={fb || !form.email.trim()}>{fb ? <Spinner /> : 'Save'}</button></div>
            </div>
          )}
          <div className="um-list ab-list">
            {q.isLoading && <PageLoader compact label="Loading address book" />}
            {shown.map(c => (
              <label key={c.idec} className={`um-item ab-row ${sel.includes(c.idec) ? 'sel' : ''}`}>
                <input type="checkbox" checked={sel.includes(c.idec)} onChange={() => toggle(c.idec)} />
                <span className="um-av" style={{ background: avColor(c.name) }}>{initials(c.name)}</span>
                <span className="um-nm"><b>{c.name}</b><small>{c.email}</small></span>
                {c.isAccount ? <em className="ab-tag">User</em> : (<span className="ab-act">
                  <button type="button" title="Change" aria-label="Change address" onClick={e => { e.preventDefault(); setForm({ idec: c.idec, name: c.name, email: c.email }); setFormErr(''); }}>✎</button>
                  <button type="button" title="Delete" aria-label="Delete address" onClick={e => { e.preventDefault(); setDel(c); }}>🗑</button></span>)}
              </label>
            ))}
            {q.data && shown.length === 0 && <div className="mh" style={{ padding: 10 }}>No addresses to add. Use “New address”.</div>}
          </div>
          <small className="mh">Tick one or more addresses and click Add. Addresses of users can only be changed in User management.</small>
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn-primary" style={{ width: 'auto' }} disabled={busy || sel.length === 0} onClick={() => onAdd(sel)}>{busy ? <Spinner /> : `Add${sel.length ? ` (${sel.length})` : ''}`}</button>
        </div>
      </div>
      {del && <ConfirmDialog danger title="Delete e-mail address?" confirmLabel="Delete" busy={fb}
        message={<>The address <b>{del.email}</b> will be deleted from the address book and from all distribution lists.</>} onConfirm={() => remove(del)} onCancel={() => setDel(null)} />}
    </div>
  );
}

/** Options > E-mail distribution (manual p. 55-62). */
export default function EmailDistribution() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const lists = useQuery({ queryKey: ['mail-lists'], queryFn: api.mailLists });
  const [sel, setSel] = useState<number | 'new' | null>(null);
  const detail = useQuery({ queryKey: ['mail-list', sel], queryFn: () => api.mailList(sel as number), enabled: typeof sel === 'number' });
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<ToastMsg>(null);
  const [busy, setBusy] = useState(false);
  const [dlg, setDlg] = useState<null | 'book' | 'del'>(null);
  const [rmMember, setRmMember] = useState<MailMember | null>(null);
  const [selMember, setSelMember] = useState<number | null>(null);

  useEffect(() => { if (sel === 'new') setName(''); else if (detail.data) setName(detail.data.name); }, [sel, detail.data?.id, detail.data?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setSelMember(null); }, [sel]);

  const run = async (fn: () => Promise<void>) => { setBusy(true); setMsg(null); try { await fn(); } catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); } };
  const refresh = async () => { await Promise.all(['mail-lists', 'mail-list', 'doc-dist'].map(k => qc.invalidateQueries({ queryKey: [k] }))); };

  const save = () => run(async () => {
    if (sel === 'new') { const r = await api.createMailList(name); await refresh(); setSel(r.id); setMsg({ ok: true, t: `Distribution list “${name.trim()}” created. Add the recipients with the + button on the right.` }); }
    else if (typeof sel === 'number') { await api.renameMailList(sel, name); await refresh(); setMsg({ ok: true, t: 'Distribution list renamed.' }); }
  });
  const remove = () => run(async () => { if (typeof sel !== 'number') return; await api.deleteMailList(sel); await refresh(); setSel(null); setMsg({ ok: true, t: 'Distribution list deleted.' }); });

  if (lists.error) return <div className="card" style={{ padding: 20 }}><div className="alert" role="alert">{(lists.error as Error).message}</div></div>;
  const d = detail.data;
  const totalMembers = lists.data?.items.reduce((a, b) => a + b.members, 0);
  const u = d?.usage;

  return (
    <div className="um">
      <PageHero icon={<IconMail />} title="E-mail distribution" sub="Distribution lists: recipients are informed when a document is released or published"
        chips={[{ n: lists.data?.items.length ?? '–', label: 'lists' }, { n: totalMembers ?? '–', label: 'recipients' }]} />
      <div className="fm">
        <div className="card fm-list">
          <fieldset className="fm-box"><legend>All distributors</legend>
            <div className="um-head"><span /><span>
              <button className="ico-btn add" title="Add distribution list" aria-label="Add distribution list" onClick={() => setSel('new')}>＋</button>
              <button className="ico-btn del" title="Delete distribution list" aria-label="Delete distribution list" disabled={busy || typeof sel !== 'number'} onClick={() => setDlg('del')}>−</button></span></div>
            {lists.isLoading && <PageLoader compact label="Loading lists" />}
            <div className="um-list users">
              {lists.data?.items.map(l => (
                <div key={l.id} className={`um-item ${sel === l.id ? 'sel' : ''}`} onClick={() => setSel(l.id)}>
                  <span className="um-av grp"><IconMail /></span>
                  <span className="um-nm"><b>{l.name}</b><small>{l.members} recipient(s){l.documents ? ` · ${l.documents} document(s)` : ''}</small></span>
                </div>
              ))}
              {lists.data?.items.length === 0 && <div className="mh" style={{ padding: 10 }}>No distribution lists yet. Click ＋ to add one.</div>}
            </div>
          </fieldset>
        </div>

        <div className="card fm-edit">
          {sel === null ? <div className="mh" style={{ padding: 20 }}>Select a distribution list on the left or add a new one.</div> : (<>
            <fieldset className="fm-box"><legend>Distributor</legend>
              <div className="fm-top">
                <div className="fm-fields"><label className="fm-row">Name<input value={name} maxLength={50} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && name.trim() && save()} /></label>
                  {u && <small className="mh">Used in {u.documents} document(s){u.audits ? `, ${u.audits} audit(s)` : ''}{u.matrix ? `, ${u.matrix} matrix entries` : ''}{u.other ? `, ${u.other} other application(s)` : ''}. A list that is still used cannot be deleted.</small>}</div>
                <div className="fm-btns"><button className="btn-primary" onClick={save} disabled={busy || !name.trim()}>{busy ? <Spinner /> : 'Save'}</button></div>
              </div>
            </fieldset>
            {typeof sel === 'number' && d && (
              <fieldset className="fm-box"><legend>Distributor users</legend>
                <div className="um-head"><span className="mh">{d.members.length} recipient(s)</span><span>
                  <button className="ico-btn add" title="Add users from the address book" aria-label="Add users" disabled={busy} onClick={() => setDlg('book')}>＋</button>
                  <button className="ico-btn del" title="Remove user from the list" aria-label="Remove user" disabled={busy || selMember === null}
                    onClick={() => { const m = d.members.find(x => x.idec === selMember); if (m) setRmMember(m); }}>−</button></span></div>
                <div className="um-list tall" style={{ maxHeight: 380 }}>
                  {d.members.map(m => (
                    <div key={m.idec} className={`um-item ${selMember === m.idec ? 'sel' : ''}`} onClick={() => setSelMember(m.idec)}>
                      <span className="um-av" style={{ background: avColor(m.name) }}>{initials(m.name)}</span>
                      <span className="um-nm"><b>{m.name}</b><small>{m.email}</small></span>
                      {m.isAccount && <em className="ab-tag">User</em>}
                    </div>
                  ))}
                  {d.members.length === 0 && <div className="mh" style={{ padding: 10 }}>No recipients yet. Click ＋ to open the address book.</div>}
                </div>
              </fieldset>
            )}
            {sel === 'new' && <small className="mh">Enter a name and click Save. Then add the recipients.</small>}
          </>)}
        </div>
      </div>

      <div className="um-status"><span className="um-count"><b>{lists.data?.items.length ?? '–'}</b> distribution lists</span><button className="um-ok" onClick={() => nav('/documents')}>OK</button></div>
      <Toast msg={msg} onClose={() => setMsg(null)} />

      {dlg === 'book' && typeof sel === 'number' && d && <AddressBook exclude={d.members.map(m => m.idec)} busy={busy} onMsg={setMsg} onCancel={() => setDlg(null)}
        onAdd={ids => run(async () => { const r = await api.addMailMembers(sel, ids); await refresh(); setDlg(null); setMsg({ ok: true, t: `${r.added} recipient(s) added to “${d.name}”.` }); })} />}
      {rmMember && typeof sel === 'number' && <ConfirmDialog danger title="Remove recipient?" confirmLabel="Remove" busy={busy}
        message={<><b>{rmMember.name}</b> ({rmMember.email}) will be removed from this distribution list. The address stays in the address book.</>}
        onConfirm={async () => { await run(async () => { await api.removeMailMember(sel, rmMember.idec); setSelMember(null); await refresh(); setMsg({ ok: true, t: 'Recipient removed from the list.' }); }); setRmMember(null); }} onCancel={() => setRmMember(null)} />}
      {dlg === 'del' && typeof sel === 'number' && <ConfirmDialog danger title="Delete distribution list?" confirmLabel="Delete" busy={busy}
        message={<>The distribution list <b>{name}</b> and its recipient assignments will be deleted. The addresses stay in the address book.</>}
        onConfirm={async () => { await remove(); setDlg(null); }} onCancel={() => setDlg(null)} />}
    </div>
  );
}
