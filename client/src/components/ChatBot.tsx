import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useLang } from '../LangContext';
import { IconSend } from './Icons';
import { respond, type Ctx, type Msg } from './assistantEngine';
import { MessageExtras, Stream, hhmm } from './AssistantParts';
import { loadConvs, newConv, saveConvs, setActive, titleOf } from './assistantStore';

const GROUPS: { title: string; items: { ico: string; label: string; q: string }[] }[] = [
  { title: 'Find', items: [
    { ico: '🔎', label: 'Search by name', q: 'Search "quality manual"' }, { ico: '🚀', label: 'Published', q: 'Show published documents' },
    { ico: '⏳', label: 'Expired', q: 'Expired documents' }, { ico: '✍️', label: 'My drafts', q: 'Drafts created by me' }] },
  { title: 'My work', items: [
    { ico: '✅', label: 'My pending tasks', q: 'Show my pending tasks' }, { ico: '📊', label: 'System overview', q: 'Give me an overview' }] },
  { title: 'Learn', items: [
    { ico: '🧭', label: 'Walk me through adding a document', q: 'Walk me through adding a document' }, { ico: '🔀', label: 'How workflow works', q: 'How does a workflow work?' },
    { ico: '🏷️', label: 'Status life cycle', q: 'What do the statuses mean?' }, { ico: '⌨️', label: 'Shortcuts', q: 'Show shortcuts' }] },
];
const SUGGEST = ['Show my pending tasks', 'Give me an overview', 'How do I release a document?', 'Expired documents', 'Help'];
const STORE = 'pl_bot_v3';
let seq = Date.now();
const SPARK = <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4z" /><path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" /></svg>;

/** Floating assistant (bottom right). Same engine as the full AI Assistant page, which it can hand the conversation over to. */
export default function ChatBot() {
  const { lang } = useLang();
  const nav = useNavigate();
  const loc = useLocation();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: Infinity });
  const [open, setOpen] = useState(false);
  const [wide, setWide] = useState(false);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const [msgs, setMsgs] = useState<Msg[]>(() => { try { return (JSON.parse(sessionStorage.getItem(STORE) ?? '{}') as { m?: Msg[] }).m ?? []; } catch { return []; } });
  const ctx = useRef<Ctx>((() => { try { return (JSON.parse(sessionStorage.getItem(STORE) ?? '{}') as { c?: Ctx }).c ?? {}; } catch { return {}; } })());
  const end = useRef<HTMLDivElement>(null);
  const inp = useRef<HTMLInputElement>(null);
  const fresh = useRef(Date.now());
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [msgs, busy, open]);
  useEffect(() => { try { sessionStorage.setItem(STORE, JSON.stringify({ m: msgs.slice(-30), c: ctx.current })); } catch { /* full */ } }, [msgs]);
  useEffect(() => { if (open) setTimeout(() => inp.current?.focus(), 60); }, [open]);
  useEffect(() => { if (!open) return; const f = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); }; window.addEventListener('keydown', f); return () => window.removeEventListener('keydown', f); }, [open]);

  if (loc.pathname.startsWith('/assistant')) return null;   // the full page has its own chat

  const first = (me.data?.name || me.data?.accShort || '').split(/[ ,]/)[0] ?? '';
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const go = (to: string) => { nav(to); setOpen(false); };
  const env = { lang, name: me.data?.name ?? '', short: me.data?.accShort ?? '' };

  async function ask(prompt: string) {
    const text = prompt.trim();
    if (!text || busy) return;
    setInput('');
    setMsgs(a => [...a, { id: ++seq, from: 'me', time: Date.now(), text }]);
    setBusy(true);
    try {
      const r = await respond(text, env, ctx.current);
      setMsgs(a => [...a, { ...r, id: ++seq, from: 'bot', time: Date.now() }]);
      if (r.navigate) setTimeout(() => go(r.navigate!), 450);
    } catch (e) {
      setMsgs(a => [...a, { id: ++seq, from: 'bot', time: Date.now(), text: 'Sorry, that did not work: ' + (e as Error).message }]);
    } finally { setBusy(false); }
  }
  const submit = (e: FormEvent) => { e.preventDefault(); void ask(input); };
  const clear = () => { setMsgs([]); ctx.current = {}; setInput(''); try { sessionStorage.removeItem(STORE); } catch { /* ignore */ } };
  const toPage = () => {
    const c = newConv();
    if (msgs.length) { c.msgs = msgs; c.ctx = ctx.current; c.title = titleOf(msgs.find(m => m.from === 'me')?.text ?? ''); saveConvs([c, ...loadConvs()]); setActive(c.id); }
    clear(); go('/assistant');
  };
  const last = msgs[msgs.length - 1];

  return (
    <>
      <button className={`bot-fab ${open ? 'open' : ''}`} onClick={() => setOpen(o => !o)} aria-label={open ? 'Close assistant' : 'Open assistant'}>
        {open ? '✕' : <><span className="bot-ico">{SPARK}</span><span className="bot-fab-text">Ask MS LDS</span></>}
      </button>
      {open && (
        <div className={`bot-panel ${wide ? 'wide' : ''}`} role="dialog" aria-label="LDS assistant">
          <div className="bot-head">
            <div className="bot-avatar">{SPARK}<i className="bot-dot" /></div>
            <div style={{ flex: 1, minWidth: 0 }}><b>LDS Assistant</b><small>Documents · Tasks · Manual answers</small></div>
            <button className="bot-ib" onClick={toPage} title="Open the full AI Assistant" aria-label="Open full assistant">↗</button>
            <button className="bot-ib" onClick={() => setWide(w => !w)} title={wide ? 'Smaller' : 'Larger'} aria-label="Resize">{wide ? '⤡' : '⤢'}</button>
            <button className="bot-ib" onClick={clear} disabled={msgs.length === 0} title="New chat" aria-label="New chat">⟲</button>
          </div>
          <div className="bot-body">
            {msgs.length === 0 && (
              <div className="bot-welcome">
                <div className="bot-hello"><span>👋</span><div><b>{greet}{first ? `, ${first}` : ''}!</b><small>Ask in plain words (typos are fine) or pick a shortcut.</small></div></div>
                {GROUPS.map(g => (
                  <div key={g.title} className="bot-grp"><h6>{g.title}</h6>
                    <div className="bot-tiles">{g.items.map(i => <button key={i.label} onClick={() => void ask(i.q)}><span>{i.ico}</span>{i.label}</button>)}</div></div>))}
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={m.id} className={`bot-msg ${m.from}`}>
                {m.from === 'bot' && <div className="bot-mav" aria-hidden="true">AI</div>}
                <div className="bot-col">
                  {m.text && <div className="bot-bubble">{m.from === 'bot' ? <Stream text={m.text} animate={m.time > fresh.current && i === msgs.length - 1} onTick={() => end.current?.scrollIntoView({ block: 'end' })} /> : m.text}</div>}
                  {m.from === 'bot' && <MessageExtras m={m} go={go} ask={q => void ask(q)} showFollow={i === msgs.length - 1} busy={busy} />}
                  <small className="bot-time">{hhmm(m.time)}</small>
                </div>
              </div>
            ))}
            {busy && <div className="bot-msg bot"><div className="bot-mav" aria-hidden="true">AI</div><div className="bot-bubble typing"><i /><i /><i /></div></div>}
            <div ref={end} />
          </div>
          {msgs.length > 0 && !last?.follow && <div className="bot-suggest">{SUGGEST.map(s => <button key={s} onClick={() => void ask(s)}>{s}</button>)}</div>}
          <form className="bot-input" onSubmit={submit}>
            <input ref={inp} value={input} onChange={e => setInput(e.target.value)} placeholder="Ask anything about documents, tasks or MS LDS…" aria-label="Message" maxLength={300} />
            <button type="submit" disabled={busy || !input.trim()} aria-label="Send"><IconSend /></button>
          </form>
        </div>
      )}
    </>
  );
}
