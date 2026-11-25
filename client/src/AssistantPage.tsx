import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useLang } from './LangContext';
import { IconSend } from './components/Icons';
import { respond, type Ctx, type Msg } from './components/assistantEngine';
import { MessageExtras, Stream, hhmm } from './components/AssistantParts';
import { getActive, loadConvs, newConv, saveConvs, setActive, titleOf, type Conv } from './components/assistantStore';
import Toast, { type ToastMsg } from './components/Toast';

const SPARK = (s = 20) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4z" /><path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" /></svg>;

const CARDS: { ico: string; title: string; sub: string; q: string; tone: string }[] = [
  { ico: '✅', title: 'My pending tasks', sub: 'What is waiting for me in the workflow?', q: 'Show my pending tasks', tone: 'a' },
  { ico: '📊', title: 'System overview', sub: 'Documents per status, expired and expiring', q: 'Give me an overview', tone: 'b' },
  { ico: '🧭', title: 'Add a document', sub: 'Walk me through it, step by step', q: 'Walk me through adding a document', tone: 'c' },
  { ico: '🚀', title: 'Release & publish', sub: 'How verify, release and publish work', q: 'How do I release and publish a document?', tone: 'd' },
  { ico: '🔀', title: 'Workflows', sub: 'Create one and use it on documents', q: 'How do I create a workflow?', tone: 'e' },
  { ico: '🔎', title: 'Search inside documents', sub: 'Full text in your files and in the manual', q: 'Which documents mention release?', tone: 'f' },
];
const IDEAS = ['Search "e-mail distribution" in the manual', 'What does Verified mean?', 'How do I rename a document?', 'What is a catchword?', 'Expired documents', 'Where are the tags?', 'How do I freeze a document?'];
let seq = Date.now();

const dayGroup = (t: number) => {
  const d = new Date(t); const now = new Date();
  const days = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 864e5);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 8 ? 'Previous 7 days' : 'Older';
};

/** Full-page AI Assistant: conversation list on the left, chat in the middle (ChatGPT style), answers from the local MS LDS engine. */
export default function AssistantPage() {
  const { lang } = useLang();
  const nav = useNavigate();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: Infinity });
  const [convs, setConvs] = useState<Conv[]>(() => loadConvs());
  const [activeId, setActiveId] = useState<string>(() => { const a = getActive(); const l = loadConvs(); return a && l.some(c => c.id === a) ? a : ''; });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [side, setSide] = useState(false);          // mobile drawer
  const [rename, setRename] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMsg>(null);
  const mounted = useRef(Date.now());
  const end = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const ctxs = useRef<Record<string, Ctx>>({});

  const conv = convs.find(c => c.id === activeId);
  const msgs = conv?.msgs ?? [];
  const first = (me.data?.name || me.data?.accShort || '').split(/[ ,]/)[0] ?? '';
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const env = { lang, name: me.data?.name ?? '', short: me.data?.accShort ?? '' };

  useEffect(() => { saveConvs(convs); }, [convs]);
  useEffect(() => { if (activeId) setActive(activeId); }, [activeId]);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [msgs.length, busy, activeId]);
  useEffect(() => { area.current?.focus(); }, [activeId]);
  useEffect(() => { const t = area.current; if (t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 180) + 'px'; } }, [input]);

  const update = (id: string, fn: (c: Conv) => Conv) => setConvs(all => all.map(c => (c.id === id ? fn(c) : c)).sort((a, b) => b.updated - a.updated));
  const ctxOf = (c: Conv) => (ctxs.current[c.id] ??= c.ctx ?? {});

  function startNew() {
    const empty = convs.find(c => c.msgs.length === 0);
    if (empty) { setActiveId(empty.id); setSide(false); return; }
    const c = newConv(); setConvs(a => [c, ...a]); setActiveId(c.id); setSide(false);
  }
  async function ask(prompt: string, regen?: { convId: string }) {
    const text = prompt.trim();
    if (!text || busy) return;
    let c = regen ? convs.find(x => x.id === regen.convId) : conv;
    if (!c) { c = newConv(); setConvs(a => [c!, ...a]); setActiveId(c.id); }
    const id = c.id;
    setInput('');
    if (!regen) update(id, x => ({ ...x, title: x.msgs.length ? x.title : titleOf(text), updated: Date.now(), msgs: [...x.msgs, { id: ++seq, from: 'me', time: Date.now(), text }] }));
    setBusy(true);
    try {
      await new Promise(r => setTimeout(r, 260));
      const r = await respond(text, env, ctxOf(c));
      update(id, x => ({ ...x, ctx: ctxOf(x), updated: Date.now(), msgs: [...x.msgs, { ...r, id: ++seq, from: 'bot', time: Date.now() }] }));
      if (r.navigate) setTimeout(() => nav(r.navigate!), 500);
    } catch (e) {
      update(id, x => ({ ...x, msgs: [...x.msgs, { id: ++seq, from: 'bot', time: Date.now(), text: 'Sorry, that did not work: ' + (e as Error).message }] }));
    } finally { setBusy(false); }
  }
  const submit = (e: FormEvent) => { e.preventDefault(); void ask(input); };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(input); } };
  const regenerate = (i: number) => {
    if (!conv || busy) return;
    const prev = [...conv.msgs.slice(0, i)].reverse().find(m => m.from === 'me');
    if (!prev?.text) return;
    update(conv.id, x => ({ ...x, msgs: x.msgs.slice(0, i) }));
    setTimeout(() => void ask(prev.text!, { convId: conv.id }), 0);
  };
  const copy = async (m: Msg) => {
    const t = [m.text, ...(m.docs ?? []).map(d => `#${d.idDoc} ${d.docName}`)].filter(Boolean).join('\n').replace(/\*\*/g, '');
    try { await navigator.clipboard.writeText(t); setToast({ t: 'Copied to the clipboard.', ok: true }); } catch { setToast({ t: 'Copy was not allowed by the browser.', ok: false }); }
  };
  const rate = (i: number, fb: 'up' | 'down') => conv && update(conv.id, x => ({ ...x, msgs: x.msgs.map((m, k) => (k === i ? { ...m, fb: m.fb === fb ? undefined : fb } : m)) }));
  const remove = (id: string) => { setConvs(a => a.filter(c => c.id !== id)); delete ctxs.current[id]; if (activeId === id) setActiveId(''); };

  const list = useMemo(() => {
    const f = q.trim().toLowerCase();
    const items = convs.filter(c => c.msgs.length > 0 && (!f || c.title.toLowerCase().includes(f)));
    const groups: [string, Conv[]][] = [];
    for (const c of items) { const g = dayGroup(c.updated); const e = groups.find(x => x[0] === g); if (e) e[1].push(c); else groups.push([g, [c]]); }
    return groups;
  }, [convs, q]);

  return (
    <div className={`ai ${side ? 'side-open' : ''}`}>
      <aside className="ai-side" aria-label="Conversations">
        <button className="ai-new" onClick={startNew}><span>＋</span> New chat</button>
        <div className="ai-search"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search chats" aria-label="Search chats" /></div>
        <div className="ai-list">
          {list.length === 0 && <div className="ai-none">{q ? 'No chat matches.' : 'Your conversations appear here.'}</div>}
          {list.map(([g, items]) => (
            <div key={g}><h6>{g}</h6>
              {items.map(c => (
                <div key={c.id} className={`ai-item ${c.id === activeId ? 'on' : ''}`} onClick={() => { setActiveId(c.id); setSide(false); }}>
                  {rename === c.id
                    ? <input autoFocus defaultValue={c.title} onClick={e => e.stopPropagation()} onBlur={e => { update(c.id, x => ({ ...x, title: e.target.value.trim() || x.title })); setRename(null); }} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRename(null); }} />
                    : <span className="t" title={c.title}>{c.title}</span>}
                  <span className="ops">
                    <button title="Rename" aria-label="Rename chat" onClick={e => { e.stopPropagation(); setRename(c.id); }}>✎</button>
                    <button title="Delete" aria-label="Delete chat" onClick={e => { e.stopPropagation(); remove(c.id); }}>🗑</button>
                  </span>
                </div>))}
            </div>))}
        </div>
        <div className="ai-foot"><span className="dot" />Runs inside your MS LDS system. Nothing is sent to an outside AI service.</div>
      </aside>

      <section className="ai-main">
        <header className="ai-bar">
          <button className="ai-burger" onClick={() => setSide(s => !s)} aria-label="Chats">☰</button>
          <div className="ai-title">{SPARK(18)}<b>MS LDS Assistant</b><span className="pill">Manual · Documents · Workflow</span></div>
          <button className="ai-ghost" onClick={startNew}>＋ New chat</button>
        </header>

        <div className="ai-scroll">
          {msgs.length === 0 ? (
            <div className="ai-hero">
              <div className="ai-logo">{SPARK(34)}</div>
              <h2>{greet}{first ? `, ${first}` : ''}.</h2>
              <p>How can I help you today? Ask about your documents, tasks and workflows, or how any MS LDS function works.</p>
              <div className="ai-cards">
                {CARDS.map(c => <button key={c.title} className={`t-${c.tone}`} onClick={() => void ask(c.q)}><span className="ico">{c.ico}</span><b>{c.title}</b><small>{c.sub}</small></button>)}
              </div>
              <div className="ai-ideas">{IDEAS.map(i => <button key={i} onClick={() => void ask(i)}>{i}</button>)}</div>
            </div>
          ) : (
            <div className="ai-thread">
              {msgs.map((m, i) => (
                <div key={m.id} className={`ai-row ${m.from}`}>
                  <div className="ai-av">{m.from === 'bot' ? SPARK(16) : (first[0] ?? 'U').toUpperCase()}</div>
                  <div className="ai-body">
                    <div className="ai-who">{m.from === 'bot' ? 'MS LDS Assistant' : 'You'}<small>{hhmm(m.time)}</small></div>
                    {m.text && <div className="ai-text">{m.from === 'bot' ? <Stream text={m.text} animate={m.time > mounted.current && i === msgs.length - 1} onTick={() => end.current?.scrollIntoView({ block: 'end' })} /> : <p>{m.text}</p>}</div>}
                    {m.from === 'bot' && <MessageExtras m={m} go={nav} ask={t => void ask(t)} showFollow={i === msgs.length - 1} busy={busy} />}
                    {m.from === 'bot' && (
                      <div className="ai-ops">
                        <button title="Copy" onClick={() => void copy(m)}>⧉ Copy</button>
                        <button title="Ask again" onClick={() => regenerate(i)} disabled={busy}>↻ Regenerate</button>
                        <button className={m.fb === 'up' ? 'on' : ''} title="Helpful" aria-label="Helpful" onClick={() => rate(i, 'up')}>👍</button>
                        <button className={m.fb === 'down' ? 'on' : ''} title="Not helpful" aria-label="Not helpful" onClick={() => rate(i, 'down')}>👎</button>
                      </div>)}
                  </div>
                </div>
              ))}
              {busy && <div className="ai-row bot"><div className="ai-av">{SPARK(16)}</div><div className="ai-body"><div className="ai-who">MS LDS Assistant</div><div className="bot-bubble typing" style={{ display: 'inline-flex' }}><i /><i /><i /></div></div></div>}
              <div ref={end} />
            </div>
          )}
        </div>

        <form className="ai-composer" onSubmit={submit}>
          <div className="ai-box">
            <textarea ref={area} rows={1} value={input} onChange={e => setInput(e.target.value)} onKeyDown={onKey} maxLength={600}
              placeholder="Message MS LDS Assistant…  (Enter to send, Shift+Enter for a new line)" aria-label="Message" />
            <button type="submit" disabled={busy || !input.trim()} aria-label="Send"><IconSend /></button>
          </div>
          <small>It answers from the MS LDS manual and your own data. Check important details in the document itself.</small>
        </form>
      </section>
      <Toast msg={toast} onClose={() => setToast(null)} />
    </div>
  );
}
