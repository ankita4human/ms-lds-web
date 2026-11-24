import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, auth, simulation } from './api';
import { useLang } from './LangContext';
import { TopProgress } from './components/Loader';
import ChatBot from './components/ChatBot';
import NotificationBell from './components/NotificationBell';
import { IconChart, IconDash, IconDocs, IconFilter, IconGear, IconType, IconUsers, IconMail, IconLogout, IconSearch, IconStd, IconDep } from './components/Icons';

const TITLES: Record<string, string> = { '/': 'Dashboard', '/analytics': 'Analytics', '/documents': 'Documents' };
const KEY = 'pl_nav_collapsed';

export default function Shell() {
  const nav = useNavigate();
  const loc = useLocation();
  const { lang, setLang, languages } = useLang();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const stdOpt = useQuery({ queryKey: ['std-options'], queryFn: api.standardOptions, staleTime: 5 * 60_000 });
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(KEY) === '1');
  const [menuOpen, setMenuOpen] = useState(false);
  const [optOpen, setOptOpen] = useState(() => location.pathname.startsWith('/options'));
  const menuRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');

  const toggle = () => setCollapsed(c => { localStorage.setItem(KEY, c ? '0' : '1'); return !c; });
  useEffect(() => {
    const close = (e: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false); };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);
  const signOut = () => { auth.clear(); nav('/login'); };
  const name = me.data?.accShort ?? '...';
  const role = me.data?.isAdmin ? 'Administrator' : 'User';

  return (
    <div className={`shell ${collapsed ? 'collapsed' : ''}`}>
      <TopProgress />
      <aside className="sidebar">
        <div className="brand"><img src="/logo-lds.png" alt="" /><div className="txt"><b>MS LDS<sup>®</sup></b><small>Document management</small></div></div>
        <div className="usercard">
          <img className="avatar" src="/user.jpg" alt="" />
          <div className="txt"><div className="name">{name}</div><div className="role">{role}</div></div>
        </div>
        <nav className="nav">
          <NavLink to="/" end title="Dashboard"><IconDash /><span className="txt">Dashboard</span></NavLink>
          <NavLink to="/analytics" title="Analytics"><IconChart /><span className="txt">Analytics</span></NavLink>
          <NavLink to="/documents" title="Documents"><IconDocs /><span className="txt">Documents</span></NavLink>
          <button className={`nav-group ${loc.pathname.startsWith('/options') ? 'open' : ''}`} onClick={() => setOptOpen(o => !o)} title="Options" aria-expanded={optOpen}>
            <IconGear /><span className="txt">Options</span><span className="caret txt">{optOpen ? '▾' : '▸'}</span>
          </button>
          {optOpen && <NavLink className="sub" to="/options/filters" title="Filter management"><IconFilter /><span className="txt">Filter management</span></NavLink>}
          {optOpen && <NavLink className="sub" to="/options/types" title="Type management"><IconType /><span className="txt">Type management</span></NavLink>}
          {optOpen && stdOpt.data?.enabled && <NavLink className="sub" to="/options/standards" title="Standard management"><IconStd /><span className="txt">Standard management</span></NavLink>}
          {optOpen && <NavLink className="sub" to="/options/dependency" title="Dependency"><IconDep /><span className="txt">Dependency</span></NavLink>}
          {optOpen && <NavLink className="sub" to="/options/users" title="User management"><IconUsers /><span className="txt">User management</span></NavLink>}
          {optOpen && <NavLink className="sub" to="/options/distribution" title="E-mail distribution"><IconMail /><span className="txt">E-mail distribution</span></NavLink>}
        </nav>
        <div className="foot"><img src="/logo-qf.png" alt="" /><span className="txt">MS QF GmbH</span></div>
      </aside>
      <div className="main">
        {simulation.active() && <div className="sim-bar" role="status">Simulation: you are working as <b>{name}</b>. <button onClick={() => { simulation.stop(); location.assign('/options/users'); }}>Return to my account</button></div>}
        <header className="topbar">
          <div className="left">
            <button className="burger" onClick={toggle} aria-label={collapsed ? 'Expand menu' : 'Collapse menu'} aria-expanded={!collapsed}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h10" /></svg>
            </button>
            <h1>{TITLES[loc.pathname] ?? 'MS LDS'}</h1>
            <form className="gsearch" role="search" onSubmit={e => { e.preventDefault(); if (q.trim()) nav(`/documents?q=${encodeURIComponent(q.trim())}`); }}>
              <IconSearch /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search documents by name or ID..." aria-label="Search documents" />
            </form>
          </div>
          <div className="right">
            <label className="lang-select">Language
              <select value={lang} onChange={e => setLang(e.target.value)} disabled={!languages.length}>
                {languages.map(l => <option key={l.lang} value={l.lang}>{l.name ? `${l.name} (${l.lang})` : l.lang}</option>)}
              </select>
            </label>
            <NotificationBell lang={lang} />
            <div className="profile" ref={menuRef}>
              <button className="profile-btn" onClick={() => setMenuOpen(o => !o)} aria-haspopup="menu" aria-expanded={menuOpen}>
                <img className="avatar sm" src="/user.jpg" alt="" />
                <span className="pn"><b>{name}</b><small>{role}</small></span>
                <span className="caret">▾</span>
              </button>
              {menuOpen && (
                <div className="profile-menu" role="menu">
                  <div className="pm-head"><img className="avatar" src="/user.jpg" alt="" /><div><b>{name}</b><small>{role}</small></div></div>
                  {me.data?.lastLogin && <div className="pm-meta">Last login: {new Date(me.data.lastLogin).toLocaleString('en-GB')}</div>}
                  <button role="menuitem" onClick={signOut}><IconLogout /> Sign out</button>
                </div>
              )}
            </div>
          </div>
        </header>
        <div className="content"><Outlet /></div>
        <ChatBot />
      </div>
    </div>
  );
}
