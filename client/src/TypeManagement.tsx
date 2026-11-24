import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from './api';
import { useLang } from './LangContext';
import { Spinner, PageLoader } from './components/Loader';
import ConfirmDialog from './components/ConfirmDialog';
import { IconType } from './components/Icons';
import PageHero from './components/PageHero';
import Toast from './components/Toast';

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
  const [askDel, setAskDel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);

  const can = list.data?.canManage ?? false;
  const cur = list.data?.items.find(t => t.idType === selId);

  function startNew() { setSelId('new'); setName(''); setShort(''); setLife(36); setTpl(false); setPao(false); setD14(false); setMsg(null); }
  useEffect(() => {
    if (!cur) return;
    setName(cur.name); setShort(cur.shortForm); setLife(cur.life); setTpl(cur.isTemplate); setPao(cur.publishAsOriginal); setD14(cur.is14DaysRelease); setMsg(null);
  }, [selId, cur?.idType]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(fn: () => Promise<void>) { setBusy(true); setMsg(null); try { await fn(); } catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); } }
  const refresh = async () => { await Promise.all(['types', 'doctypes', 'filter-opts'].map(k => qc.invalidateQueries({ queryKey: [k] }))); };
  const body = () => ({ lang, name: name.trim(), shortForm: short.trim(), life, isTemplate: tpl, publishAsOriginal: pao, is14DaysRelease: d14 });
  const save = () => run(async () => {
    if (!name.trim()) throw new Error('Please enter a name.');
    if (!short.trim()) throw new Error('Please enter a short form.');
    const r = selId === 'new' ? await api.createType(body()) : await api.updateType(selId as number, body());
    await refresh(); setSelId(r.idType); setMsg({ ok: true, t: 'Document type saved.' });
  });
  const remove = () => run(async () => {
    if (typeof selId !== 'number') return;
    await api.deleteType(selId); await refresh(); setSelId(null); setMsg({ ok: true, t: 'Document type deleted.' });
  });
  const makeDefault = () => run(async () => { if (typeof selId === 'number') { await api.setDefaultType(selId); await refresh(); setMsg({ ok: true, t: 'Set as default type for new documents.' }); } });

  return (
    <div className="um">
      <PageHero icon={<IconType />} title="Type management" sub="Document types, lifetime and publishing options" chips={[{ n: list.data?.items.length ?? '–', label: 'types' }, { n: list.data?.items.filter(x => x.isTemplate).length ?? '–', label: 'templates' }]} />
      <div className="fm">
      <div className="card fm-list">
        <div className="fm-list-head"><b>All document types</b>
          <span><button className="ico-btn add" title="Add new document type" aria-label="Add new document type" onClick={startNew} disabled={!can}>＋</button>
            <button className="ico-btn del" title="Delete document type" aria-label="Delete document type" onClick={() => setAskDel(true)} disabled={busy || !can || typeof selId !== 'number'}>−</button></span>
        </div>
        {list.isLoading && <PageLoader compact label="Loading types" />}
        {list.data?.items.map(t => (
          <div key={t.idType} className={`fm-item ${selId === t.idType ? 'sel' : ''}`} onClick={() => setSelId(t.idType)}>
            <span className="fm-av t">{(t.shortForm || t.name).slice(0, 3).toUpperCase()}</span><span className="nm">{t.name}</span>
            <span><small className="mh">{t.documents}</small>{t.isDefault && <i title="Default type">⭐</i>}</span>
          </div>
        ))}
        {list.data?.items.length === 0 && <div className="mh" style={{ padding: 10 }}>No document types.</div>}
      </div>

      <div className="card fm-edit">
        {selId === null ? <div className="mh" style={{ padding: 20 }}>Select a document type on the left or add a new one.{!can && ' You may view the types but not change them.'}</div> : (<>
          <fieldset className="fm-box"><legend>Document type</legend>
            <div className="fm-top">
              <div className="fm-fields">
                <label className="fm-row">Name<input value={name} maxLength={40} onChange={e => setName(e.target.value)} disabled={!can} /></label>
                <label className="fm-row">Short form<input value={short} maxLength={12} onChange={e => setShort(e.target.value)} disabled={!can} /></label>
                <label className="fm-row">Default lifetime
                  <span className="fm-life"><input type="number" min={1} max={720} value={life} disabled={!can}
                    onChange={e => setLife(Math.max(1, Math.min(720, Math.trunc(Number(e.target.value)) || 1)))} /> Months <small className="mh">(1–720, default 36)</small></span></label>
                <div className="fm-row">Template:<label className="fm-chk"><input type="checkbox" checked={tpl} disabled={!can} onChange={e => setTpl(e.target.checked)} />These document types are available as a template.</label></div>
                <div className="fm-row">Publish as original:<label className="fm-chk"><input type="checkbox" checked={pao} disabled={!can} onChange={e => setPao(e.target.checked)} />You have to republish all the documents having this type to reflect changes.</label></div>
                <div className="fm-row">14 Days Release<label className="fm-chk"><input type="checkbox" checked={d14} disabled={!can} onChange={e => setD14(e.target.checked)} />Document will be published 14 days after release.</label></div>
                {cur?.untranslated && <small className="mh">The text starts with a language marker such as &lt;DE&gt;: this type is not translated into {lang} yet. Replace the text and save to translate it.</small>}
              </div>
              <div className="fm-btns">
                <button className="btn-primary" onClick={save} disabled={busy || !can}>{busy ? <Spinner /> : 'Save'}</button>
                {typeof selId === 'number' && <button className="btn-ghost" onClick={makeDefault} disabled={busy || !can || cur?.isDefault}>{cur?.isDefault ? '⭐ Default type' : 'Set as default'}</button>}
                <button className="btn-ghost" onClick={() => nav('/documents')}>Close</button>
              </div>
            </div>
          </fieldset>
          {cur && <small className="mh">{cur.documents} document(s) use this type in {lang}. A type that is in use or is the default type cannot be deleted. Changes apply to all languages.</small>}
        </>)}
      </div>
      {askDel && <ConfirmDialog danger title="Delete document type?" confirmLabel="Delete" busy={busy}
        message={<>The document type <b>{name}</b> will be removed in all languages. This is only possible while no document uses it.</>}
        onConfirm={async () => { await remove(); setAskDel(false); }} onCancel={() => setAskDel(false)} />}
      </div>
      <Toast msg={msg} onClose={() => setMsg(null)} />
    </div>
  );
}
