import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, auth } from './api';
import { PageLoader, Spinner } from './components/Loader';
import { IconEye, IconLock, IconUser } from './components/Icons';

export default function Login() {
  const nav = useNavigate();
  const [login, setLogin] = useState(''); const [pw, setPw] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr('');
    try { auth.set((await api.login(login.trim(), pw)).token); nav('/'); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="login">
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
      <section className="login-panel">
        <form className="login-card" onSubmit={submit}>
          <img className="logo" src="/logo-lds.png" alt="MS LDS" />
          <h2>Welcome back</h2>
          <div className="sub">Sign in to continue to MS LDS.</div>
          {err && <div className="alert" role="alert">{err}</div>}
          <div className="field">
            <label htmlFor="u">Login</label>
            <div className="input-wrap"><IconUser /><input id="u" value={login} onChange={e => setLogin(e.target.value)} autoFocus autoComplete="username" /></div>
          </div>
          <div className="field">
            <label htmlFor="p">Password</label>
            <div className="input-wrap">
              <IconLock />
              <input id="p" type={show ? 'text' : 'password'} value={pw} onChange={e => setPw(e.target.value)} autoComplete="current-password" />
              <button type="button" className="eye" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'}><IconEye off={show} /></button>
            </div>
          </div>
          <button className="btn-primary" disabled={busy || !login || !pw}>{busy ? <><Spinner />Signing in</> : 'Sign in'}</button>
          <div className="login-foot">© MS QF GmbH</div>
        </form>
      </section>
    </div>
  );
}
