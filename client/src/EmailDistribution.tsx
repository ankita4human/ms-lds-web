import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, type MailMember } from './api';
import { Spinner, PageLoader } from './components/Loader';
import ConfirmDialog from './components/ConfirmDialog';
import Toast, { type ToastMsg } from './components/Toast';
import PageHero from './components/PageHero';
import { IconMail } from './components/Icons';
import { SaveBar, useSaveShortcut } from './components/FormBits';
import { tr } from './i18n';

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
        onMsg({ ok: true, t: r.existed ? tr('This e-mail address already exists in the address book; it has been selected.') : tr('E-mail address added to the address book.') });
      } else {
        await api.changeMailContact(form.idec, form.name, form.email);
        await qc.invalidateQueries({ queryKey: ['mail-contacts'] }); await qc.invalidateQueries({ queryKey: ['mail-list'] });
        onMsg({ ok: true, t: tr('E-mail address changed.') });
      }
      setForm(null);
    } catch (e) { setFormErr((e as Error).message); } finally { setFb(false); }
  }
  async function remove(c: MailMember) {
    setFb(true);
    try { await api.deleteMailContact(c.idec); setSel(s => s.filter(x => x !== c.idec)); await qc.invalidateQueries({ queryKey: ['mail-contacts'] }); await qc.invalidateQueries({ queryKey: ['mail-list'] }); await qc.invalidateQueries({ queryKey: ['mail-lists'] }); onMsg({ ok: true, t: tr('Address {0} deleted.', c.email) }); }
    catch (e) { onMsg({ ok: false, t: (e as Error).message }); } finally { setFb(false); setDel(null); }
  }

  return (
    <div className="modal-back" style={{ zIndex: 90 }} onMouseDown={() => !busy && onCancel()}>
      <div className="modal um-pick ab" role="dialog" aria-modal="true" aria-label={tr('Address book')} onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head"><b>{tr('MS LDS Address Book')}</b></div>
        <div className="um-pick-body">
          <div className="ab-bar">
            <input placeholder={tr('Search name or e-mail…')} value={search} onChange={e => setSearch(e.target.value)} autoFocus />
            <button className="btn-ghost" onClick={() => { setForm({ idec: null, name: '', email: '' }); setFormErr(''); }}>{tr('＋ New address')}</button>
          </div>
          {form && (
            <div className="ab-form">
              <b>{form.idec === null ? tr('Add e-mail address') : tr('Change e-mail address')}</b>
              <label className="fm-row">{tr('Name')}<input value={form.name} maxLength={50} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
              <label className="fm-row">{tr('E-mail')}<input type="email" value={form.email} maxLength={100} onChange={e => setForm({ ...form, email: e.target.value })} /></label>
              {formErr && <div className="alert" role="alert">{formErr}</div>}
              <div className="um-btns"><button className="btn-ghost" onClick={() => setForm(null)} disabled={fb}>{tr('Cancel')}</button>
                <button className="btn-primary" style={{ width: 'auto' }} onClick={saveForm} disabled={fb || !form.email.trim()}>{fb ? <Spinner /> : tr('Save')}</button></div>
            </div>
          )}
          <div className="um-list ab-list">
            {q.isLoading && <PageLoader compact label={tr('Loading address book')} />}
            {shown.map(c => (
              <label key={c.idec} className={`um-item ab-row ${sel.includes(c.idec) ? 'sel' : ''}`}>
                <input type="checkbox" checked={sel.includes(c.idec)} onChange={() => toggle(c.idec)} />
                <span className="um-av" style={{ background: avColor(c.name) }}>{initials(c.name)}</span>
                <span className="um-nm"><b>{c.name}</b><small>{c.email}</small></span>
                {c.isAccount ? <em className="ab-tag">{tr('User')}</em> : (<span className="ab-act">
                  <button type="button" title={tr('Change')} aria-label={tr('Change address')} onClick={e => { e.preventDefault(); setForm({ idec: c.idec, name: c.name, email: c.email }); setFormErr(''); }}>✎</button>
                  <button type="button" title={tr('Delete')} aria-label={tr('Delete address')} onClick={e => { e.preventDefault(); setDel(c); }}>🗑</button></span>)}
              </label>
            ))}
            {q.data && shown.length === 0 && <div className="mh" style={{ padding: 10 }}>{tr('No addresses to add. Use “New address”.')}</div>}
          </div>
          <small className="mh">{tr('Tick one or more addresses and click Add. Addresses of users can only be changed in User management.')}</small>
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onCancel} disabled={busy}>{tr('Cancel')}</button>
          <button className="btn-primary" style={{ width: 'auto' }} disabled={busy || sel.length === 0} onClick={() => onAdd(sel)}>{busy ? <Spinner /> : tr('Add{0}', sel.length ? ` (${sel.length})` : '')}</button>
        </div>
      </div>
      {del && <ConfirmDialog danger title={tr('Delete e-mail address?')} confirmLabel={tr('Delete')} busy={fb}
        message={<>{tr('The address')}{' '}<b>{del.email}</b> {tr('will be deleted from the address book and from all distribution lists.')}</>} onConfirm={() => remove(del)} onCancel={() => setDel(null)} />}
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
  const [name, setName] = useState(''); const [base, setBase] = useState('');
  const [q, setQ] = useState(''); const [mq, setMq] = useState('');
  const [msg, setMsg] = useState<ToastMsg>(null);
  const [busy, setBusy] = useState(false);
  const [dlg, setDlg] = useState<null | 'book' | 'del'>(null);
  const [rmMembers, setRmMembers] = useState<MailMember[] | null>(null);
  const [checked, setChecked] = useState<number[]>([]);
  const [pending, setPending] = useState<number | 'new' | null | undefined>(undefined);

  useEffect(() => {
    if (sel === 'new') { setName(''); setBase(''); }
    else if (detail.data) { setName(detail.data.name); setBase(detail.data.name); }
  }, [sel, detail.data?.id, detail.data?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setChecked([]); setMq(''); }, [sel]);

  const run = async (fn: () => Promise<void>) => { setBusy(true); setMsg(null); try { await fn(); } catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); } };
  const refresh = async () => { await Promise.all(['mail-lists', 'mail-list', 'doc-dist'].map(k => qc.invalidateQueries({ queryKey: [k] }))); };
  const dirty = sel !== null && name !== base;
  const open = (id: number | 'new' | null) => { if (dirty && id !== sel) setPending(id); else setSel(id); };

  const save = () => run(async () => {
    if (!name.trim()) throw new Error(tr('Please enter a name.'));
    if (sel === 'new') { const r = await api.createMailList(name); await refresh(); setBase(name); setSel(r.id); setMsg({ ok: true, t: tr('Distribution list “{0}” created. Add the recipients with the Add button.', name.trim()) }); }
    else if (typeof sel === 'number') { await api.renameMailList(sel, name); await refresh(); setBase(name); setMsg({ ok: true, t: tr('Distribution list renamed.') }); }
  });
  const remove = () => run(async () => { if (typeof sel !== 'number') return; await api.deleteMailList(sel); await refresh(); setBase(''); setSel(null); setMsg({ ok: true, t: tr('Distribution list deleted.') }); });
  useSaveShortcut(() => { if (!busy && dirty && name.trim()) void save(); }, sel !== null);

  const d = detail.data;
  const u = d?.usage;
  const usedTotal = (u?.documents ?? 0) + (u?.audits ?? 0) + (u?.matrix ?? 0) + (u?.other ?? 0);
  const totalMembers = lists.data?.items.reduce((a, b) => a + b.members, 0);
  const shownLists = useMemo(() => (lists.data?.items ?? []).filter(l => !q.trim() || l.name.toLowerCase().includes(q.trim().toLowerCase())), [lists.data, q]);
  const members = useMemo(() => (d?.members ?? []).filter(m => !mq.trim() || `${m.name} ${m.email}`.toLowerCase().includes(mq.trim().toLowerCase())), [d, mq]);
  const toggle = (id: number) => setChecked(c => c.includes(id) ? c.filter(x => x !== id) : [...c, id]);
  const allChecked = members.length > 0 && members.every(m => checked.includes(m.idec));
  const copyMails = async () => {
    const txt = (d?.members ?? []).filter(m => !checked.length || checked.includes(m.idec)).map(m => m.email).join('; ');
    try { await navigator.clipboard.writeText(txt); setMsg({ ok: true, t: tr('{0} e-mail address(es) copied.', txt.split('; ').filter(Boolean).length) }); } catch { setMsg({ ok: false, t: tr('Copy is not allowed in this browser.') }); }
  };

  if (lists.error) return <div className="card" style={{ padding: 20 }}><div className="alert" role="alert">{(lists.error as Error).message}</div></div>;

  return (
    <div className="um">
      <PageHero icon={<IconMail />} title={tr('E-mail distribution')} sub={tr('Distribution lists: recipients are informed when a document is released or published')}
        chips={[{ n: lists.data?.items.length ?? '–', label: 'lists' }, { n: totalMembers ?? '–', label: 'recipients' }]} />
      <div className="fx">
        <aside className="card fx-list">
          <button className="fx-new" onClick={() => open('new')}><span>＋</span> {tr('New distribution list')}</button>
          <div className="fx-search"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg><input value={q} onChange={e => setQ(e.target.value)} placeholder={tr('Search lists')} aria-label={tr('Search lists')} /></div>
          <div className="fx-items">
            {lists.isLoading && <PageLoader compact label={tr('Loading lists')} />}
            {shownLists.map(l => (
              <button key={l.id} className={`fx-item ${sel === l.id ? 'sel' : ''}`} onClick={() => open(l.id)}>
                <span className="um-av grp"><IconMail /></span>
                <span className="tx"><b>{l.name}</b><small>{l.members} {tr('recipient')}{l.members === 1 ? '' : 's'}{l.documents ? tr(' · {0} document{1}', l.documents, l.documents === 1 ? '' : 's') : ''}</small></span>
              </button>))}
            {lists.data && shownLists.length === 0 && <div className="fx-empty">{lists.data.items.length ? tr('No list matches.') : tr('No distribution lists yet. Create the first one!')}</div>}
          </div>
        </aside>

        <section className="card fx-edit">
          {sel === null ? (
            <div className="fx-hero"><div className="big">📬</div><h3>{tr('Select a distribution list or create one')}</h3>
              <p>{tr('People on a list get an e-mail when a document is released or published.')}</p>
              <button className="btn-primary" onClick={() => open('new')}>{tr('＋ New distribution list')}</button></div>
          ) : (<>
            <div className="fx-head">
              <div className="fx-namebox">
                <input value={name} maxLength={50} placeholder={tr('List name, e.g. Quality team')} aria-label={tr('Distribution list name')} autoFocus={sel === 'new'} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && name.trim() && dirty && void save()} />
                {d && <div className="fx-count"><b>{d.members.length}</b><span>{tr('recipient')}{d.members.length === 1 ? '' : 's'}</span></div>}
              </div>
              {u && <div className="fx-usagechips">
                <span title={tr('Documents using this list')}>📄 {u.documents} {tr('document')}{u.documents === 1 ? '' : 's'}</span>
                {u.audits > 0 && <span>🔎 {u.audits} {tr('audit')}{u.audits === 1 ? '' : 's'}</span>}
                {u.matrix > 0 && <span>🧮 {u.matrix} {tr('matrix entries')}</span>}
                {u.other > 0 && <span>🧩 {u.other} {tr('other')}</span>}
                {usedTotal > 0 && <span className="warn">{tr('In use: cannot be deleted')}</span>}</div>}
            </div>

            <div className="fx-pane">
              {typeof sel === 'number' && d ? (
                <div className="fx-panel wide">
                  <div className="fx-panel-head"><b><span>👥</span>{tr('Recipients')}<em>{d.members.length}</em></b>
                    <span className="fx-bulk">
                      {checked.length > 0 && <button className="btn-ghost danger" disabled={busy} onClick={() => setRmMembers(d.members.filter(m => checked.includes(m.idec)))}>{tr('Remove')}{' '}{checked.length}</button>}
                      <button className="btn-ghost" disabled={d.members.length === 0} onClick={() => void copyMails()}>{checked.length ? tr('Copy {0} e-mail(s)', checked.length) : tr('Copy all e-mails')}</button>
                      <button className="fx-add" disabled={busy} onClick={() => setDlg('book')}>{tr('＋ Add from address book')}</button></span></div>
                  {d.members.length > 5 && <div className="fx-selrow">
                    <label className="fx-all"><input type="checkbox" checked={allChecked} onChange={() => setChecked(allChecked ? checked.filter(id => !members.some(m => m.idec === id)) : [...new Set([...checked, ...members.map(m => m.idec)])])} />{tr('Select all')}{mq ? ' shown' : ''}</label>
                    <input className="fx-mini" placeholder={tr('Find a recipient…')} value={mq} onChange={e => setMq(e.target.value)} /></div>}
                  <div className="fx-rows tall">
                    {members.map(m => (
                      <label key={m.idec} className={`fx-row sel-able ${checked.includes(m.idec) ? 'on' : ''}`}>
                        <input type="checkbox" checked={checked.includes(m.idec)} onChange={() => toggle(m.idec)} />
                        <span className="um-av" style={{ background: avColor(m.name) }}>{initials(m.name)}</span>
                        <span className="nm"><b>{m.name}</b><small>{m.email}</small></span>
                        {m.isAccount && <em className="ab-tag">{tr('User')}</em>}
                        <button type="button" aria-label={tr('Remove {0}', m.name)} title={tr('Remove from list')} disabled={busy} onClick={e => { e.preventDefault(); setRmMembers([m]); }}>×</button>
                      </label>))}
                    {d.members.length === 0 && <div className="fx-empty">{tr('No recipients yet. Click “Add from address book”.')}</div>}
                    {d.members.length > 0 && members.length === 0 && <div className="fx-empty">{tr('Nobody matches.')}</div>}
                  </div>
                </div>
              ) : sel === 'new' ? <div className="fx-hint">{tr('Enter a name and click Save. Then add the recipients.')}</div> : <PageLoader compact label={tr('Loading list')} />}
            </div>

            <SaveBar dirty={dirty} busy={busy} canSave={!!name.trim()} onSave={() => void save()} onReset={() => setName(base)}>
              {typeof sel === 'number' && <button className="btn-ghost danger" disabled={busy || usedTotal > 0} title={usedTotal > 0 ? tr('This list is still in use') : tr('Delete list')} onClick={() => setDlg('del')}>{tr('Delete')}</button>}
              <button className="btn-ghost" onClick={() => nav('/documents')}>{tr('Close')}</button>
            </SaveBar>
          </>)}
        </section>
      </div>
      <Toast msg={msg} onClose={() => setMsg(null)} />

      {pending !== undefined && <ConfirmDialog title={tr('Discard your changes?')} confirmLabel={tr('Discard')} busy={false}
        message={<>{tr('You changed the list name and did not save it.')}</>} onConfirm={() => { setSel(pending); setPending(undefined); }} onCancel={() => setPending(undefined)} />}
      {dlg === 'book' && typeof sel === 'number' && d && <AddressBook exclude={d.members.map(m => m.idec)} busy={busy} onMsg={setMsg} onCancel={() => setDlg(null)}
        onAdd={ids => run(async () => { const r = await api.addMailMembers(sel, ids); await refresh(); setDlg(null); setMsg({ ok: true, t: tr('{0} recipient(s) added to “{1}”.', r.added, d.name) }); })} />}
      {rmMembers && typeof sel === 'number' && <ConfirmDialog danger title={rmMembers.length > 1 ? tr('Remove recipients?') : tr('Remove recipient?')} confirmLabel={tr('Remove')} busy={busy}
        message={rmMembers.length === 1 ? <><b>{rmMembers[0]!.name}</b> ({rmMembers[0]!.email}{tr(') will be removed from this distribution list. The address stays in the address book.')}</> : <><b>{rmMembers.length} {tr('recipients')}</b> {tr('will be removed from this distribution list. Their addresses stay in the address book.')}</>}
        onConfirm={async () => { await run(async () => { for (const m of rmMembers) await api.removeMailMember(sel, m.idec); setChecked([]); await refresh(); setMsg({ ok: true, t: rmMembers.length > 1 ? tr('{0} recipients removed from the list.', rmMembers.length) : tr('Recipient removed from the list.') }); }); setRmMembers(null); }} onCancel={() => setRmMembers(null)} />}
      {dlg === 'del' && typeof sel === 'number' && <ConfirmDialog danger title={tr('Delete distribution list?')} confirmLabel={tr('Delete')} busy={busy}
        message={<>{tr('The distribution list')}{' '}<b>{name}</b> {tr('and its recipient assignments will be deleted. The addresses stay in the address book.')}</>}
        onConfirm={async () => { await remove(); setDlg(null); }} onCancel={() => setDlg(null)} />}
    </div>
  );
}
