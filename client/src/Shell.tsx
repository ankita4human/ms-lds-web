import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, auth, simulation } from './api';
import { useLang } from './LangContext';
import { TopProgress } from './components/Loader';
import ChatBot from './components/ChatBot';
import ActivityTray from './components/ActivityTray';
import NotificationBell from './components/NotificationBell';
import ThemeSwitch from './components/ThemeSwitch';
import SkinSwitch from './components/SkinSwitch';
import UserAvatar, { AvatarEditor } from './components/UserAvatar';
import SimulateDialog from './components/SimulateDialog';
import ViewStyle from './components/ViewStyle';
import UiLangSwitch from './components/UiLangSwitch';
import { t, useI18n, tr } from './i18n';
import { IconChart, IconDash, IconDocs, IconFilter, IconGear, IconType, IconUsers, IconMail, IconLogout, IconSearch, IconStd, IconDep, IconFlow, IconTask, IconCatch, IconTag, IconSliders, IconSpark } from './components/Icons';

const titleOf = (p: string) => ({ '/assistant': t('nav.assistant'), '/tasks': t('nav.tasks'), '/options/workflows': t('nav.workflows'), '/options/catch': t('nav.catch'), '/options/tags': t('nav.tags'), '/options/program': t('nav.program'), '/': t('nav.dashboard'), '/analytics': t('nav.analytics'), '/documents': t('nav.documents') } as Record<string, string>)[p];
const KEY = 'pl_nav_collapsed';

export default function Shell() {
  const nav = useNavigate();
  const loc = useLocation();
  const { lang, setLang, languages } = useLang();
  const { locale } = useI18n();   // re-render when the interface language changes
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const stdOpt = useQuery({ queryKey: ['std-options'], queryFn: api.standardOptions, staleTime: 5 * 60_000 });
  const wfCfg = useQuery({ queryKey: ['wf-config'], queryFn: api.wfConfig, staleTime: 5 * 60_000 });
  const catchCfg = useQuery({ queryKey: ['catch-config'], queryFn: api.catchConfig, staleTime: 5 * 60_000 });
  const wfCount = useQuery({ queryKey: ['wf-summary'], queryFn: api.wfSummary, enabled: !!wfCfg.data?.canUse, refetchInterval: 30_000, refetchOnWindowFocus: true, staleTime: 10_000 });
  const openTasks = wfCount.data?.total ?? 0;
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(KEY) === '1');
  const [menuOpen, setMenuOpen] = useState(false);
  const [simOpen, setSimOpen] = useState(false);
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
  const fullName = me.data?.name || me.data?.accShort;
  const role = me.data?.isAdmin ? t('role.admin') : t('role.user');

  return (
    <div className={`shell ${collapsed ? 'collapsed' : ''}`}>
      <TopProgress />
      <aside className="sidebar">
        <div className="brand"><img src="/logo-lds.png" alt="" /><div className="txt"><b>{tr('MS LDS')}<sup>®</sup></b><small>{t('brand.sub')}</small></div></div>
        <div className="usercard">
          <AvatarEditor id={me.data?.idAcc} name={fullName} />
          <div className="txt"><div className="name">{name}</div><div className="role">{role}</div></div>
        </div>
        <nav className="nav">
          <NavLink to="/" end title={t('nav.dashboard')}><IconDash /><span className="txt">{t('nav.dashboard')}</span></NavLink>
          <NavLink to="/analytics" title={t('nav.analytics')}><IconChart /><span className="txt">{t('nav.analytics')}</span></NavLink>
          <NavLink to="/documents" title={t('nav.documents')}><IconDocs /><span className="txt">{t('nav.documents')}</span></NavLink>
          {wfCfg.data?.canUse && <NavLink to="/tasks" title={t('nav.tasks')}><IconTask /><span className="txt">{t('nav.tasks')}</span>{openTasks > 0 && <span className={`nav-badge ${wfCount.data?.overdue ? 'late' : ''}`} title={tr('{0} open task(s){1}', openTasks, wfCount.data?.overdue ? `, ${wfCount.data.overdue} overdue` : '')}>{openTasks > 99 ? '99+' : openTasks}</span>}</NavLink>}
          <button className={`nav-group ${loc.pathname.startsWith('/options') ? 'open' : ''}`} onClick={() => setOptOpen(o => !o)} title={t('nav.options')} aria-expanded={optOpen}>
            <IconGear /><span className="txt">{t('nav.options')}</span><span className="caret txt">{optOpen ? '▾' : '▸'}</span>
          </button>
          {optOpen && <NavLink className="sub" to="/options/filters" title={t('nav.filters')}><IconFilter /><span className="txt">{t('nav.filters')}</span></NavLink>}
          {optOpen && <NavLink className="sub" to="/options/types" title={t('nav.types')}><IconType /><span className="txt">{t('nav.types')}</span></NavLink>}
          {optOpen && stdOpt.data?.enabled && <NavLink className="sub" to="/options/standards" title={t('nav.standards')}><IconStd /><span className="txt">{t('nav.standards')}</span></NavLink>}
          {optOpen && wfCfg.data?.canManage && <NavLink className="sub" to="/options/workflows" title={t('nav.workflows')}><IconFlow /><span className="txt">{t('nav.workflows')}</span></NavLink>}
          {optOpen && catchCfg.data?.canManage && <NavLink className="sub" to="/options/catch" title={t('nav.catch')}><IconCatch /><span className="txt">{t('nav.catch')}</span></NavLink>}
          {optOpen && <NavLink className="sub" to="/options/tags" title={t('nav.tags')}><IconTag /><span className="txt">{t('nav.tags')}</span></NavLink>}
          {optOpen && <NavLink className="sub" to="/options/program" title={t('nav.program')}><IconSliders /><span className="txt">{t('nav.program')}</span></NavLink>}
          {optOpen && (me.data?.isAdmin || me.data?.rights.includes(41)) && !simulation.active() && (
            <button className="nav-sub-sim" onClick={() => setSimOpen(true)} title={t('nav.simulateTip')}><span className="sim-emo" aria-hidden>🎭</span><span className="txt">{t('nav.simulate')}</span></button>)}
          {optOpen && <NavLink className="sub" to="/options/dependency" title={t('nav.dependency')}><IconDep /><span className="txt">{t('nav.dependency')}</span></NavLink>}
          {optOpen && <NavLink className="sub" to="/options/users" title={t('nav.users')}><IconUsers /><span className="txt">{t('nav.users')}</span></NavLink>}
          {optOpen && <NavLink className="sub" to="/options/distribution" title={t('nav.distribution')}><IconMail /><span className="txt">{t('nav.distribution')}</span></NavLink>}
          <NavLink to="/assistant" title={t('nav.assistant')} className="nav-ai"><IconSpark /><span className="txt">{t('nav.assistant')}</span><span className="nav-new txt">{tr('AI')}</span></NavLink>
        </nav>
        <div className="foot"><img src="/logo-qf.png" alt="" /><span className="txt">{tr('MS QF GmbH')}</span></div>
      </aside>
      <div className="main">
        {simulation.active() && <div className="sim-bar" role="status">{t('sim.bar')} <b>{name}</b>. <button onClick={() => { simulation.stop(); location.assign('/options/users'); }}>{t('sim.return')}</button></div>}
        <header className="topbar has-center">
          <div className="left">
            <button className="burger" onClick={toggle} aria-label={collapsed ? t('head.menuExpand') : t('head.menuCollapse')} aria-expanded={!collapsed}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h10" /></svg>
            </button>
            <h1>{titleOf(loc.pathname) ?? tr('MS LDS')}</h1>
            <form className="gsearch" role="search" onSubmit={e => { e.preventDefault(); if (q.trim()) nav(`/documents?q=${encodeURIComponent(q.trim())}`); }}>
              <IconSearch /><input value={q} onChange={e => setQ(e.target.value)} placeholder={t('head.search')} aria-label={t('head.searchLabel')} />
            </form>
          </div>
          <div className="center"><UiLangSwitch /></div>
          <div className="right">
            <label className="lang-select" title={t('head.docLang')}>{t('head.docLang')}
              <select value={lang} onChange={e => setLang(e.target.value)} disabled={!languages.length}>
                {languages.map(l => <option key={l.lang} value={l.lang}>{l.name ? `${l.name} (${l.lang})` : l.lang}</option>)}
              </select>
            </label>
            <SkinSwitch />
            <ThemeSwitch />
            <NotificationBell lang={lang} />
            <div className="profile" ref={menuRef}>
              <button className="profile-btn" onClick={() => setMenuOpen(o => !o)} aria-haspopup="menu" aria-expanded={menuOpen}>
                <UserAvatar id={me.data?.idAcc} className="avatar sm" name={fullName} />
                <span className="pn"><b>{name}</b><small>{role}</small></span>
                <span className="caret">▾</span>
              </button>
              {menuOpen && (
                <div className="profile-menu" role="menu">
                  <div className="pm-head"><AvatarEditor id={me.data?.idAcc} name={fullName} /><div><b>{name}</b><small>{role}</small></div></div>
                  {me.data?.lastLogin && <div className="pm-meta">{t('head.lastLogin')}: {new Date(me.data.lastLogin).toLocaleString(locale)}</div>}
                  <button role="menuitem" onClick={signOut}><IconLogout /> {t('head.signOut')}</button>
                </div>
              )}
            </div>
          </div>
        </header>
        <div className="content"><Outlet /></div>
        <ActivityTray />
        <ChatBot />
      </div>
      {simOpen && <SimulateDialog onClose={() => setSimOpen(false)} />}
      <ViewStyle />
    </div>
  );
}
