import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, auth } from './api';
import { PageLoader, Spinner } from './components/Loader';
import { IconEye, IconLock, IconUser } from './components/Icons';
import LoginMonkey from './components/LoginMonkey';

const REMEMBER = 'pl_login';
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
function greeting() { const h = new Date().getHours(); return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; }

export default function Login() {
  const nav = useNavigate();
  const saved = (() => { try { return localStorage.getItem(REMEMBER) ?? ''; } catch { return ''; } })();
  const [login, setLogin] = useState(saved); const [pw, setPw] = useState('');
  const [remember, setRemember] = useState(!!saved);
  const [show, setShow] = useState(false);
  const [focus, setFocus] = useState<'none' | 'user' | 'pw'>('none');
  const [caps, setCaps] = useState(false);
  const [mouse, setMouse] = useState({ x: 0, y: 0 });
  const [shake, setShake] = useState(false);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false); const [ok, setOk] = useState(false);
  const pwRef = useRef<HTMLInputElement>(null); const box = useRef<HTMLFormElement>(null);
  useEffect(() => { if (saved) pwRef.current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const t = (await api.login(login.trim(), pw)).token;
      try { if (remember) localStorage.setItem(REMEMBER, login.trim()); else localStorage.removeItem(REMEMBER); } catch { /* storage blocked */ }
      setOk(true); auth.set(t); nav('/');
    } catch (x) {
      setErr((x as Error).message); setShake(true); setTimeout(() => setShake(false), 520); setPw(''); pwRef.current?.focus();
    } finally { setBusy(false); }
  }
  // the monkey looks at the pointer; while you type the login it follows the cursor position in the text
  function onMove(ev: React.MouseEvent) {
    const r = box.current?.getBoundingClientRect(); if (!r) return;
    const dx = (ev.clientX - (r.left + r.width / 2)) / 260, dy = (ev.clientY - (r.top + 40)) / 260;
    setMouse({ x: clamp(dx, -1, 1) * 3.6, y: clamp(dy, -1, 1) * 3 });
  }
  const look = focus === 'user' ? { x: clamp((login.length - 9) * 0.5, -3.6, 3.6), y: 2.6 } : focus === 'pw' ? { x: 0, y: 0 } : mouse;
  const cover = focus === 'pw' && !show;
  const peek = focus === 'pw' && show;
  const mood = ok ? 'happy' : err && !busy ? 'sad' : 'idle';
  const caps2 = (ev: React.KeyboardEvent) => setCaps(ev.getModifierState?.('CapsLock') ?? false);

  return (
    <div className="login" onMouseMove={onMove}>
      {busy && <div className="login-overlay"><PageLoader compact label="Signing you in" /></div>}
      <section className="login-hero">
        <div>
          <div className="brand-row"><img src="/logo-lds.png" alt="MS LDS" /><b>MS LDS<sup>®</sup> Web</b></div>
          <h1>Your management system documents, always in reach.</h1>
          <p>Browse the document structure, follow every version and release, and keep an overview of status and expiry dates, from any browser.</p>
          <img className="mock" src="/hero.png" alt="MS LDS on laptop and phone" />
        </div>
        <div className="hero-foot"><img src="/logo-qf.png" alt="MS QF" /> MS QF GmbH · Integrated management systems</div>
      </section>
      <section className="login-panel wl-panel">
        <i className="wl-bloom b1" /><i className="wl-bloom b2" /><i className="wl-bloom b3" />
        <form className={`login-card wl-card ${shake ? 'shake' : ''}`} onSubmit={submit} ref={box}>
          <LoginMonkey cover={cover} peek={peek} mood={mood} look={look} />
          <div className="wl-hello">{greeting()}</div>
          <h2>Welcome back</h2>
          <div className="sub">Sign in to continue to MS LDS.</div>
          {err && <div className="alert wl-alert" role="alert">{err}</div>}
          <div className="wl-field">
            <label htmlFor="u">Login</label>
            <div className="wl-input"><IconUser />
              <input id="u" value={login} onChange={e => setLogin(e.target.value)} onFocus={() => setFocus('user')} onBlur={() => setFocus('none')}
                autoFocus={!saved} autoComplete="username" spellCheck={false} placeholder="Your login name" /></div>
          </div>
          <div className="wl-field" onFocus={() => setFocus('pw')} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocus('none'); }}>
            <label htmlFor="p">Password</label>
            <div className="wl-input"><IconLock />
              <input id="p" ref={pwRef} type={show ? 'text' : 'password'} value={pw} onChange={e => setPw(e.target.value)} onKeyDown={caps2} onKeyUp={caps2}
                autoComplete="current-password" placeholder="Your password" />
              <button type="button" className="eye" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'} title={show ? 'Hide password' : 'Show password (the monkey will peek!)'}><IconEye off={show} /></button>
            </div>
            {caps && focus === 'pw' && <div className="wl-caps" role="status">⇪ Caps Lock is on</div>}
          </div>
          <div className="wl-row">
            <label className="wl-check"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} /><span /> Remember my login name</label>
          </div>
          <button className="wl-go" disabled={busy || !login || !pw}>{busy ? <><Spinner />Signing in</> : <>Sign in <span aria-hidden>→</span></>}</button>
          <div className="login-foot">© MS QF GmbH</div>
        </form>
      </section>
    </div>
  );
}
