import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from './api';
import { useLang } from './LangContext';
import { Spinner, PageLoader } from './components/Loader';
import ConfirmDialog from './components/ConfirmDialog';
import { IconType } from './components/Icons';
import PageHero from './components/PageHero';
import Toast, { type ToastMsg } from './components/Toast';
import { SaveBar, Switch, hue, useSaveShortcut } from './components/FormBits';

const PRESETS = [12, 24, 36, 60];
const human = (m: number) => {
  const y = Math.floor(m / 12), r = m % 12;
  const ys = y ? `${y} year${y > 1 ? 's' : ''}` : '';
  const ms = r ? `${r} month${r > 1 ? 's' : ''}` : '';
  return [ys, ms].filter(Boolean).join(' ') || '0 months';
};
const expiry = (m: number) => { const d = new Date(); d.setMonth(d.getMonth() + m); return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }); };
const badgeStyle = (s: string) => ({ background: `linear-gradient(135deg,hsl(${hue(s)} 70% 52%),hsl(${(hue(s) + 40) % 360} 70% 42%))` });

/** Options > Type management (manual p. 39-41): add, change and delete document types; name, short form, default lifetime, template. */
export default function TypeManagement() {
  const { lang } = useLang();
  const qc = useQueryClient();
  const nav = useNavigate();
  const list = useQuery({ queryKey: ['types', lang], queryFn: () => api.types(lang), enabled: !!lang });
  const [selId, setSelId] = useState<number | 'new' | null>(null);
  const [name, setName] = useState(''); const [short, setShort] = useState('');
  const [life, setLife] = useState(36); const [tpl, setTpl] = useState(false);
  const [pao, setPao] = useState(false); const [d14, setD14] = useState(false);
  const [base, setBase] = useState('');
  const [q, setQ] = useState(''); const [sort, setSort] = useState<'name' | 'docs'>('name');
  const [askDel, setAskDel] = useState(false);
  const [pending, setPending] = useState<number | 'new' | null | undefined>(undefined);
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<ToastMsg>(null);
  const [touched, setTouched] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const can = list.data?.canManage ?? false;
  const items = list.data?.items ?? [];
  const cur = items.find(t => t.idType === selId);
  const snap = (n = name, s = short, l = life, t = tpl, p = pao, d = d14) => JSON.stringify({ n, s, l, t, p, d });
  const dirty = selId !== null && snap() !== base;
  const nameErr = touched && !name.trim() ? 'Please enter a name.' : '';
  const shortErr = touched && !short.trim() ? 'Please enter a short form.' : '';
  const used = cur?.documents ?? 0;
  const totalDocs = items.reduce((a, t) => a + t.documents, 0);

  const shown = useMemo(() => items
    .filter(t => !q.trim() || `${t.name} ${t.shortForm}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => sort === 'docs' ? b.documents - a.documents || a.name.localeCompare(b.name) : a.name.localeCompare(b.name)), [items, q, sort]);

  function fill(n: string, s: string, l: number, t: boolean, p: boolean, d: boolean) {
    setName(n); setShort(s); setLife(l); setTpl(t); setPao(p); setD14(d); setBase(snap(n, s, l, t, p, d));
  }
  function open(id: number | 'new' | null) { if (dirty && id !== selId) setPending(id); else go(id); }
  function go(id: number | 'new' | null) {
    setPending(undefined); setMsg(null); setTouched(false); setSelId(id);
    if (id === 'new') { fill('', '', 36, false, false, false); setTimeout(() => nameRef.current?.focus(), 50); }
  }
  useEffect(() => {
    if (!cur) return;
    fill(cur.name, cur.shortForm, cur.life, cur.isTemplate, cur.publishAsOriginal, cur.is14DaysRelease);
  }, [selId, cur?.idType, cur?.name, cur?.shortForm, cur?.life, cur?.isTemplate, cur?.publishAsOriginal, cur?.is14DaysRelease]); // eslint-disable-line react-hooks/exhaustive-deps
  const reset = () => { try { const b = JSON.parse(base) as { n: string; s: string; l: number; t: boolean; p: boolean; d: boolean }; setName(b.n); setShort(b.s); setLife(b.l); setTpl(b.t); setPao(b.p); setD14(b.d); setTouched(false); } catch { /* none */ } };

  async function run(fn: () => Promise<void>) { setBusy(true); setMsg(null); try { await fn(); } catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); } }
  const refresh = async () => { await Promise.all(['types', 'doctypes', 'filter-opts'].map(k => qc.invalidateQueries({ queryKey: [k] }))); };
  const body = () => ({ lang, name: name.trim(), shortForm: short.trim(), life, isTemplate: tpl, publishAsOriginal: pao, is14DaysRelease: d14 });
  const save = () => run(async () => {
    setTouched(true);
    if (!name.trim()) { nameRef.current?.focus(); throw new Error('Please enter a name.'); }
    if (!short.trim()) throw new Error('Please enter a short form.');
    const r = selId === 'new' ? await api.createType(body()) : await api.updateType(selId as number, body());
    await refresh(); setBase(snap()); setSelId(r.idType); setMsg({ ok: true, t: `Document type “${name.trim()}” saved.` });
  });
  const remove = () => run(async () => {
    if (typeof selId !== 'number') return;
    await api.deleteType(selId); setAskDel(false); await refresh(); setBase(''); setSelId(null); setMsg({ ok: true, t: 'Document type deleted.' });
  });
  const makeDefault = () => run(async () => { if (typeof selId === 'number') { await api.setDefaultType(selId); await refresh(); setMsg({ ok: true, t: 'Set as default type for new documents.' }); } });
  const duplicate = () => { const n = name, s = short, l = life, t = tpl, p = pao, d = d14; setSelId('new'); fill(`${n} (copy)`, s, l, t, p, d); setBase(''); setTimeout(() => nameRef.current?.select(), 50); setMsg({ ok: true, t: 'Copy created: adjust the name and save.' }); };
  useSaveShortcut(() => { if (!busy && can && dirty) void save(); }, selId !== null);

  const previewShort = (short.trim() || name.trim() || '?').slice(0, 4).toUpperCase();
  const canDelete = can && typeof selId === 'number' && used === 0 && !cur?.isDefault;

  return (
    <div className="um">
      <PageHero icon={<IconType />} title="Type management" sub="Document types, lifetime and publishing options" chips={[{ n: items.length || '–', label: 'types' }, { n: items.filter(x => x.isTemplate).length, label: 'templates' }, { n: totalDocs, label: 'documents' }]} />
      <div className="fx">
        <aside className="card fx-list">
          <button className="fx-new" onClick={() => open('new')} disabled={!can}><span>＋</span> New document type</button>
          <div className="fx-search"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search types" aria-label="Search types" /></div>
          <div className="fx-seg">
            <button className={sort === 'name' ? 'on' : ''} onClick={() => setSort('name')}>A–Z</button>
            <button className={sort === 'docs' ? 'on' : ''} onClick={() => setSort('docs')}>Most used</button>
          </div>
          <div className="fx-items">
            {list.isLoading && <PageLoader compact label="Loading types" />}
            {shown.map(t => (
              <button key={t.idType} className={`fx-item ${selId === t.idType ? 'sel' : ''}`} onClick={() => open(t.idType)}>
                <span className="badge" style={badgeStyle(t.shortForm || t.name)}>{(t.shortForm || t.name).slice(0, 3).toUpperCase()}</span>
                <span className="tx"><b>{t.name}</b>
                  <small>{t.documents} document{t.documents === 1 ? '' : 's'} · {human(t.life)}{t.isTemplate ? ' · 📋' : ''}{t.publishAsOriginal ? ' · 📤' : ''}{t.is14DaysRelease ? ' · ⏱' : ''}</small></span>
                {t.isDefault && <i title="Default type">⭐</i>}
              </button>
            ))}
            {!list.isLoading && shown.length === 0 && <div className="fx-empty">{items.length ? 'No type matches.' : 'No document types yet.'}</div>}
          </div>
          <div className="fx-hint" style={{ padding: '4px 10px 10px' }}>📋 template · 📤 publish as original · ⏱ 14-day release</div>
        </aside>

        <section className="card fx-edit">
          {selId === null ? (
            <div className="fx-hero">
              <div className="big">🏷️</div><h3>Choose a document type, or create a new one</h3>
              <p>Types decide the default lifetime, whether a document is a template and how it is published.{!can && ' You may view the types but not change them.'}</p>
              {can && <button className="btn-primary" onClick={() => open('new')}>＋ New document type</button>}
            </div>
          ) : (<>
            <div className="fx-head">
              <div className="fx-namebox tp">
                <span className="badge lg" style={badgeStyle(short || name || '?')}>{previewShort}</span>
                <div className="fld">
                  <input ref={nameRef} value={name} maxLength={40} onChange={e => setName(e.target.value)} onBlur={() => setTouched(true)} disabled={!can} placeholder="Type name, e.g. Work instruction" aria-label="Name" aria-invalid={!!nameErr} />
                  <div className="cc"><span className="err">{nameErr}</span><span>{name.length}/40</span></div>
                </div>
                <div className="fld sm">
                  <input value={short} maxLength={12} onChange={e => setShort(e.target.value)} onBlur={() => setTouched(true)} disabled={!can} placeholder="Short form" aria-label="Short form" aria-invalid={!!shortErr} />
                  <div className="cc"><span className="err">{shortErr}</span><span>{short.length}/12</span></div>
                </div>
              </div>
              {cur?.untranslated && <div className="fx-ro">🌐 The text starts with a language marker such as &lt;DE&gt;: this type is not translated into {lang} yet. Replace the text and save to translate it.</div>}
              {!can && <div className="fx-ro">🔒 You may view the types but not change them.</div>}
            </div>

            <div className="fx-pane">
              <div className="fx-field">
                <div className="fx-lbl">Default lifetime<span className="fx-lbl-tools"><em>{human(life)}</em></span></div>
                <div className="fx-life">
                  <input type="range" min={1} max={120} step={1} value={Math.min(life, 120)} disabled={!can} onChange={e => setLife(Number(e.target.value))} aria-label="Lifetime in months" />
                  <span className="num"><input type="number" min={1} max={720} value={life} disabled={!can} onChange={e => setLife(Math.max(1, Math.min(720, Math.trunc(Number(e.target.value)) || 1)))} /> months</span>
                </div>
                <div className="quick fx-quick">
                  {PRESETS.map(p => <button key={p} type="button" className={life === p ? 'on' : ''} disabled={!can} onClick={() => setLife(p)}>{human(p)}</button>)}
                </div>
                <div className="fx-hint">A document of this type created today would expire on <b>{expiry(life)}</b>. Allowed range 1–720 months.{life > 120 && ' Use the number box for values above 10 years.'}</div>
              </div>

              <div className="fx-switches col">
                <Switch checked={tpl} disabled={!can} onChange={setTpl} label="📋 Available as template" desc="Documents of this type can be used as a template for new documents." />
                <Switch checked={pao} disabled={!can} onChange={setPao} label="📤 Publish as original" desc="You have to republish all the documents having this type to reflect changes." />
                <Switch checked={d14} disabled={!can} onChange={setD14} label="⏱ 14 days release" desc="Document will be published 14 days after release." />
              </div>

              {cur && (
                <div className="fx-usage">
                  <div className="top"><b>{used}</b> document{used === 1 ? '' : 's'} use this type in {lang}{cur.isDefault && <span className="tag">⭐ Default type</span>}</div>
                  <div className="bar"><i style={{ width: `${totalDocs ? Math.max(used ? 3 : 0, Math.round(used * 100 / totalDocs)) : 0}%` }} /></div>
                  <div className="fx-hint">{used > 0 ? 'This type is in use and cannot be deleted.' : cur.isDefault ? 'The default type cannot be deleted. Make another type the default first.' : 'Nobody uses this type, so it can be deleted.'} Changes apply to all languages.</div>
                </div>
              )}
            </div>

            <SaveBar dirty={dirty} busy={busy} canSave={can && !!name.trim() && !!short.trim()} onSave={() => void save()} onReset={reset}>
              {typeof selId === 'number' && <>
                <button className="btn-ghost" onClick={makeDefault} disabled={busy || !can || cur?.isDefault}>{cur?.isDefault ? '⭐ Default' : 'Set as default'}</button>
                <button className="btn-ghost" onClick={duplicate} disabled={!can}>Duplicate</button>
                <button className="btn-ghost danger" onClick={() => setAskDel(true)} disabled={busy || !canDelete} title={canDelete ? 'Delete this type' : 'In use or default: cannot be deleted'}>Delete</button></>}
              <button className="btn-ghost" onClick={() => nav('/documents')}>Close</button>
            </SaveBar>
          </>)}
        </section>
      </div>
      {askDel && <ConfirmDialog danger title="Delete document type?" confirmLabel="Delete" busy={busy}
        message={<>The document type <b>{name}</b> will be removed in all languages. This is only possible while no document uses it.</>}
        onConfirm={remove} onCancel={() => setAskDel(false)} />}
      {pending !== undefined && <ConfirmDialog title="Discard your changes?" confirmLabel="Discard" busy={false}
        message={<>You changed <b>{name || 'this type'}</b> and did not save it. If you continue, the changes are lost.</>}
        onConfirm={() => go(pending)} onCancel={() => setPending(undefined)} />}
      <Toast msg={msg} onClose={() => setMsg(null)} />
    </div>
  );
}
