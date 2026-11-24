import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type DocQuery, type DocRow } from '../api';
import { useLang } from '../LangContext';
import { StatusBadge, fmtDate } from './bits';
import { IconSend } from './Icons';

/* ---------- Prompt understanding (rule based, runs in the browser; no external AI service) ---------- */
const STATUS: [RegExp, number, string][] = [
  [/\bdrafts?\b/, 1, 'Draft'], [/\b(in edit|editing|in progress)\b/, 2, 'Edit'], [/\bpublished\b/, 3, 'Published'],
  [/\bpresent\b/, 4, 'Present'], [/\barchived?\b/, 5, 'Archived'], [/\bverified\b/, 7, 'Verified'],
  [/\breleased\b/, 8, 'Released'], [/\bblocked\b/, 9, 'Blocked'], [/\bfrozen\b/, 11, 'Frozen'],
];
const FILLER = new Set(('show me list find search get give all the a an of for with documents document docs doc files file please ' +
  'which are is that who whose have has had status named called name containing contains about on in by from to and or my me i what how many count total number').split(' '));

type Parsed = { q: DocQuery; chips: string[]; countOnly: boolean; help: boolean; idOnly?: number };

export function parsePrompt(raw: string, me: string): Parsed {
  let t = ' ' + raw.toLowerCase().replace(/[?!]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
  const q: DocQuery = { page: 1, pageSize: 8, sort: 'modified', desc: true };
  const chips: string[] = [];
  const take = (re: RegExp) => { const m = t.match(re); if (m) t = t.replace(m[0], ' '); return m; };
  if (/^\s*(help|\?|what can you do)\s*$/.test(t)) return { q, chips, countOnly: false, help: true };

  const countOnly = /\b(how many|count|number of|total)\b/.test(t);

  // document id: "id 123", "doc #123", "document 123", or a bare number
  const idm = take(/\b(?:id|doc|document|no\.?|#)\s*[:#]?\s*(\d{1,9})\b/) ?? take(/^\s*#?(\d{1,9})\s*$/);
  if (idm) { q.text = idm[1]; chips.push(`ID ${idm[1]}`); return { q, chips, countOnly, help: false, idOnly: Number(idm[1]) }; }

  // people: "published by X", "released by X", "created/authored/written by X"
  const person = (verbs: string) => take(new RegExp(`\\b(?:${verbs})\\s+by\\s+(me|[\\w.\\-@]+)`));
  const pub = person('published|publish'), rel = person('released|release'), cre = person('created|authored|written|made|uploaded|owned');
  const who = (v: string) => (v === 'me' ? me : v);
  if (pub) { q.publisher = who(pub[1]); chips.push(`Publisher: ${q.publisher}`); }
  if (rel) { q.releaser = who(rel[1]); chips.push(`Releaser: ${q.releaser}`); }
  if (cre) { q.creator = who(cre[1]); chips.push(`Creator: ${q.creator}`); }
  // "by X" alone, or "my documents"
  const by = take(/\bby\s+(me|[\w.\-@]+)/);
  const mine = !by && take(/\b(my|mine)\b/);
  const person2 = by ? who(by[1]) : mine ? me : undefined;

  // status words
  for (const [re, id, name] of STATUS) if (re.test(t)) { q.status = id; chips.push(`Status: ${name}`); t = t.replace(re, ' '); break; }
  if (/\b(expired|overdue|out of date)\b/.test(t)) { q.expired = true; chips.push('Expired'); t = t.replace(/\b(expired|overdue|out of date)\b/, ' '); }

  if (person2) {
    if (q.status === 3 && !q.publisher) { q.publisher = person2; chips.push(`Publisher: ${person2}`); }
    else if (q.status === 8 && !q.releaser) { q.releaser = person2; chips.push(`Releaser: ${person2}`); }
    else if (!q.creator && !q.publisher && !q.releaser) { q.creator = person2; chips.push(`Creator: ${person2}`); }
  }

  // free text: a quoted phrase wins, otherwise whatever is left after removing filler words
  const quoted = raw.match(/["“'](.+?)["”']/);
  let text = quoted ? quoted[1] : t.split(' ').filter(w => w && !FILLER.has(w)).join(' ');
  text = text.trim();
  if (text) { q.text = text; chips.push(`Name contains “${text}”`); }
  return { q, chips, countOnly, help: false };
}

/* ---------- UI ---------- */
type Msg = { from: 'bot' | 'me'; text?: string; chips?: string[]; docs?: DocRow[]; total?: number; query?: DocQuery };

const SUGGEST = [
  'Show published documents', 'Documents published by martin', 'Released by me',
  'How many drafts?', 'Expired documents', 'Find document 1001', 'Search "quality manual"',
];

const WELCOME: Msg = {
  from: 'bot',
  text: 'Hi! I am the LDS assistant. Ask me for documents by name, ID, status, or who created, published or released them.',
};

export default function ChatBot() {
  const { lang } = useLang();
  const nav = useNavigate();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: Infinity });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const [msgs, setMsgs] = useState<Msg[]>([WELCOME]);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, busy, open]);

  async function ask(prompt: string) {
    const text = prompt.trim();
    if (!text || busy) return;
    setInput('');
    setMsgs(m => [...m, { from: 'me', text }]);
    const p = parsePrompt(text, me.data?.accShort ?? '');
    if (p.help) {
      setMsgs(m => [...m, { from: 'bot', text: 'Try: “published documents by martin”, “drafts created by me”, “released by anna”, “expired documents”, “document 1234”, “how many verified?”, or a name such as “quality manual”.' }]);
      return;
    }
    if (!p.chips.length) {
      setMsgs(m => [...m, { from: 'bot', text: 'I could not find anything to search for in that. Type a name, an ID, a status, or “published by <user>”. Type “help” for examples.' }]);
      return;
    }
    setBusy(true);
    try {
      const res = await api.documents({ ...p.q, lang, pageSize: p.countOnly ? 1 : 8, withPaths: !p.countOnly });
      setMsgs(m => [...m, {
        from: 'bot', chips: p.chips, total: res.total, query: p.q,
        docs: p.countOnly ? [] : res.items,
        text: res.total === 0 ? 'No documents match that (within the groups you may access).'
          : p.countOnly ? `${res.total} document${res.total === 1 ? '' : 's'} match.`
          : `Found ${res.total} document${res.total === 1 ? '' : 's'}${res.total > res.items.length ? `, showing the latest ${res.items.length}` : ''}.`,
      }]);
    } catch (e) {
      setMsgs(m => [...m, { from: 'bot', text: 'Sorry, the search failed: ' + (e as Error).message }]);
    } finally { setBusy(false); }
  }

  const submit = (e: FormEvent) => { e.preventDefault(); void ask(input); };

  return (
    <>
      <button className={`bot-fab ${open ? 'open' : ''}`} onClick={() => setOpen(o => !o)} aria-label={open ? 'Close assistant' : 'Open assistant'}>
        {open ? '✕' : <><span className="bot-ico">💬</span><span className="bot-fab-text">Ask LDS</span></>}
      </button>
      {open && (
        <div className="bot-panel" role="dialog" aria-label="LDS assistant">
          <div className="bot-head">
            <div className="bot-avatar">AI</div>
            <div style={{ flex: 1 }}><b>LDS Assistant</b><small>Search documents in plain words</small></div>
            <button className="bot-clear" onClick={() => { setMsgs([WELCOME]); setInput(''); }} disabled={msgs.length <= 1} title="Clear chat">🗑 Clear</button>
          </div>
          <div className="bot-body">
            {msgs.map((m, i) => (
              <div key={i} className={`bot-msg ${m.from}`}>
                {m.text && <div className="bot-bubble">{m.text}</div>}
                {m.chips && <div className="bot-chips">{m.chips.map(c => <span key={c}>{c}</span>)}</div>}
                {m.docs && m.docs.length > 0 && (
                  <div className="bot-results">
                    {m.docs.map(d => (
                      <button key={`${d.idDoc}${d.lang}`} className="bot-doc" onClick={() => { nav(`/documents?doc=${d.idDoc}`); setOpen(false); }}>
                        <div className="bot-doc-top"><b>#{d.idDoc}</b><StatusBadge id={d.status} name={d.statusName} /></div>
                        <div className="bot-doc-name">{d.docName}</div>
                        {d.paths && d.paths.length > 0 && (
                          <div className="bot-doc-path" title={d.paths.join('\n')}>
                            📁 {d.paths[0].split(' / ').map((p, i, a) => <span key={i}>{p}{i < a.length - 1 && <em> › </em>}</span>)}
                            {d.paths.length > 1 && <small> +{d.paths.length - 1} more</small>}
                          </div>
                        )}
                        <div className="bot-doc-meta">
                          {d.publisher ? `Published by ${d.publisher}${d.datePub ? ' · ' + fmtDate(d.datePub) : ''}` : d.creator ? `Created by ${d.creator}` : ''}
                          {d.releaser ? ` · Released by ${d.releaser}` : ''}
                        </div>
                      </button>
                    ))}
                    {m.query?.text && !m.query.creator && !m.query.publisher && !m.query.releaser && m.total! > m.docs.length && (
                      <button className="bot-more" onClick={() => { nav(`/documents?q=${encodeURIComponent(m.query!.text!)}`); setOpen(false); }}>
                        Open all {m.total} in Documents
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
            {busy && <div className="bot-msg bot"><div className="bot-bubble typing"><i /><i /><i /></div></div>}
            <div ref={end} />
          </div>
          <div className="bot-suggest">{SUGGEST.map(s => <button key={s} onClick={() => void ask(s)}>{s}</button>)}</div>
          <form className="bot-input" onSubmit={submit}>
            <input value={input} onChange={e => setInput(e.target.value)} placeholder="e.g. published documents by martin" aria-label="Message" />
            <button type="submit" disabled={busy || !input.trim()} aria-label="Send"><IconSend /></button>
          </form>
        </div>
      )}
    </>
  );
}
