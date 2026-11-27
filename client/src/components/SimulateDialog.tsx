import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, propsApi, simulation } from '../api';
import { Spinner } from './Loader';
import './simdlg.css';
import { tr } from '../i18n';

const hue = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
const ini = (s: string) => s.split(/[\s.@_\-\[\]]+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '?';

/** Sidebar "Simulate profile" (same function as the Simulate button in User management; needs the Simulation right or Admin).
 *  Work as another user to check what that profile sees; "Return to my account" in the orange bar ends it. */
export default function SimulateDialog({ onClose }: { onClose: () => void }) {
  const list = useQuery({ queryKey: ['simulatable'], queryFn: propsApi.simulatable, gcTime: 0 });
  const [q, setQ] = useState('');
  const [pick, setPick] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [busy, onClose]);
  const shown = useMemo(() => { const t = q.trim().toLowerCase(); return (list.data ?? []).filter(u => !t || u.name.toLowerCase().includes(t) || u.login.toLowerCase().includes(t)); }, [list.data, q]);
  const chosen = list.data?.find(u => u.id === pick) ?? null;
  const go = async () => {
    if (!chosen) return;
    setBusy(true); setErr('');
    try { const r = await api.simulateUser(chosen.id); simulation.start(r.token, r.login); location.assign('/documents'); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <div className="modal-back" onMouseDown={() => !busy && onClose()}>
      <div className="modal sm-dlg" role="dialog" aria-label={tr('Simulate profile')} onMouseDown={e => e.stopPropagation()}>
        <div className="sm-head"><span className="sm-ico" aria-hidden>🎭</span><div><h3>{tr('Simulate profile')}</h3><small>{tr('Work as another user to see exactly what that profile sees')}</small></div>
          <button className="x" onClick={onClose} disabled={busy} aria-label={tr('Close')}>✕</button></div>
        <input className="sm-search" autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={tr('Search by name or login…')} aria-label={tr('Search users')} />
        <div className="sm-list" role="listbox" aria-label={tr('Users')}>
          {list.isLoading && <div className="sm-empty"><Spinner /> {tr('Loading users…')}</div>}
          {list.isError && <div className="alert" role="alert">{(list.error as Error).message}</div>}
          {list.data && shown.length === 0 && <div className="sm-empty">{tr('No user found.')}</div>}
          {shown.map(u => (
            <button key={u.id} role="option" aria-selected={pick === u.id} className={`sm-user${pick === u.id ? ' on' : ''}`} onClick={() => setPick(u.id)} onDoubleClick={() => { setPick(u.id); }}>
              <i style={{ background: `linear-gradient(135deg, hsl(${hue(u.login)} 70% 58%), hsl(${(hue(u.login) + 40) % 360} 65% 44%))` }}>{ini(u.name)}</i>
              <span><b>{u.name}</b><small>{u.login}</small></span>{pick === u.id && <em aria-hidden>✓</em>}
            </button>))}
        </div>
        <div className="sm-note">{tr('⚠️ Everything you do is done as')}{' '}<b>{chosen ? chosen.name : 'the chosen user'}</b>{tr('. An orange bar at the top lets you return to your own account.')}</div>
        {err && <div className="alert" role="alert">{err}</div>}
        <div className="sm-foot"><button className="btn-ghost" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
          <button className="sm-go" onClick={go} disabled={!chosen || busy}>{busy ? <><Spinner />{tr('Starting')}</> : tr('🎭 Simulate{0}', chosen ? ' ' + chosen.login : '')}</button></div>
      </div>
    </div>
  );
}
