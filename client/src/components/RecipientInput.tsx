import { useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type MailRecip } from '../api';
import { tr } from '../i18n';

export const isEmail = (s: string) => /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]{2,}$/.test(s.trim());

const SRC: Record<string, string> = { default: 'Default recipient (DB Tool setting)', saved: 'Saved for this document', owner: 'Process owner', typed: 'Added by you', book: 'Address book' };
const srcTitle = (s?: string) => !s ? '' : s.startsWith('list:') ? tr('Distribution list: {0}', s.slice(5)) : SRC[s] ?? s;
const srcClass = (s?: string) => !s ? '' : s.startsWith('list:') ? 'list' : s;

/** To / CC field: addresses as chips, type or paste addresses, pick from the address book, or add a whole distribution list. */
export default function RecipientInput({ label, value, onChange, hint }: {
  label: string; value: MailRecip[]; onChange: (v: MailRecip[]) => void; hint?: string;
}) {
  const contacts = useQuery({ queryKey: ['mail-contacts'], queryFn: api.mailContacts, staleTime: 5 * 60_000 });
  const lists = useQuery({ queryKey: ['mail-lists'], queryFn: api.mailLists, staleTime: 5 * 60_000 });
  const [text, setText] = useState('');
  const [focus, setFocus] = useState(false);
  const [hi, setHi] = useState(0);
  const [listsOpen, setListsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const inp = useRef<HTMLInputElement>(null);

  const has = (e: string) => value.some(v => v.email.toLowerCase() === e.toLowerCase());
  function add(items: MailRecip[]) {
    const next = [...value];
    for (const it of items) if (it.email && !next.some(v => v.email.toLowerCase() === it.email.toLowerCase())) next.push(it);
    if (next.length !== value.length) onChange(next);
  }
  function commit(raw: string) {
    const parts = raw.split(/[;,\s]+/).map(s => s.trim()).filter(Boolean);
    if (parts.length) add(parts.map(p => ({ email: p, src: 'typed' })));
    setText('');
  }
  const matches = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return [];
    return (contacts.data ?? []).filter(c => c.email && !has(c.email) && (c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q))).slice(0, 7);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, contacts.data, value]);

  async function addList(id: number) {
    setBusy(true);
    try {
      const d = await api.mailList(id);
      add(d.members.filter(m => m.email).map(m => ({ email: m.email, name: m.name, src: `list:${d.name}` })));
    } finally { setBusy(false); setListsOpen(false); }
  }

  return (
    <div className="rc">
      <div className="rc-label"><span>{label}</span>{hint && <small>{hint}</small>}</div>
      <div className={`rc-box ${focus ? 'focus' : ''}`} onClick={() => inp.current?.focus()}>
        {value.map(v => (
          <span key={v.email} className={`rc-chip ${srcClass(v.src)} ${isEmail(v.email) ? '' : 'bad'}`} title={isEmail(v.email) ? srcTitle(v.src) : tr('Not a valid e-mail address')}>
            {v.name ? <><b>{v.name}</b><i>{v.email}</i></> : v.email}
            <button type="button" aria-label={tr('Remove {0}', v.email)} onClick={e => { e.stopPropagation(); onChange(value.filter(x => x.email !== v.email)); }}>×</button>
          </span>))}
        <input ref={inp} value={text} placeholder={value.length ? '' : tr('Type an address or a name…')} aria-label={label}
          onChange={e => { setText(e.target.value); setHi(0); }}
          onFocus={() => setFocus(true)} onBlur={() => { setFocus(false); if (text.trim()) commit(text); }}
          onPaste={e => { const t = e.clipboardData.getData('text'); if (/[;,\s]/.test(t.trim())) { e.preventDefault(); commit(t); } }}
          onKeyDown={e => {
            if (e.key === 'ArrowDown' && matches.length) { e.preventDefault(); setHi(h => (h + 1) % matches.length); }
            else if (e.key === 'ArrowUp' && matches.length) { e.preventDefault(); setHi(h => (h + matches.length - 1) % matches.length); }
            else if (e.key === 'Enter' || e.key === ';' || e.key === ',') {
              e.preventDefault();
              if (e.key === 'Enter' && matches[hi] && !isEmail(text)) { add([{ email: matches[hi].email, name: matches[hi].name, src: 'book' }]); setText(''); }
              else if (text.trim()) commit(text);
            }
            else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
          }} />
        {(lists.data?.items.length ?? 0) > 0 && (
          <button type="button" className="rc-lists" onMouseDown={e => e.preventDefault()} onClick={e => { e.stopPropagation(); setListsOpen(o => !o); }} aria-expanded={listsOpen}>
            {busy ? '…' : tr('＋ List')}</button>)}
        {focus && matches.length > 0 && (
          <div className="rc-pop" role="listbox">
            {matches.map((c, i) => (
              <button key={c.idec} type="button" role="option" aria-selected={i === hi} className={i === hi ? 'on' : ''}
                onMouseDown={e => { e.preventDefault(); add([{ email: c.email, name: c.name, src: 'book' }]); setText(''); }}>
                <b>{c.name}</b><span>{c.email}</span></button>))}
          </div>)}
        {listsOpen && (
          <div className="rc-pop lists" role="menu">
            <div className="rc-pop-h">{tr('Add all members of a distribution list')}</div>
            {lists.data?.items.map(l => (
              <button key={l.id} type="button" role="menuitem" onClick={e => { e.stopPropagation(); addList(l.id); }} disabled={busy || l.members === 0}>
                <b>{l.name}</b><span>{l.members} {tr('member')}{l.members === 1 ? '' : 's'}</span></button>))}
          </div>)}
      </div>
    </div>
  );
}
