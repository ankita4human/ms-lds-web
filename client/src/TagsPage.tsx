import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from './api';
import { useLang } from './LangContext';
import { PageLoader } from './components/Loader';
import { IconTag } from './components/Icons';
import PageHero from './components/PageHero';
import Toast from './components/Toast';
import { tr } from './i18n';

type Kind = 'doc' | 'app' | 'other';

/** Options > Tags (manual p. 91-93; legacy "Tags/Links" window). Predefined tags that are replaced by the current values when a document
 *  is published / previewed / viewed / printed. Selecting a tag copies it to the clipboard. */
export default function TagsPage() {
  const { lang } = useLang();
  const nav = useNavigate();
  const [kind, setKind] = useState<Kind>('doc');
  const [app, setApp] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null);
  const q = useQuery({ queryKey: ['tags', lang, kind, app], queryFn: () => api.tags(lang, kind, app), enabled: !!lang, placeholderData: p => p });
  useEffect(() => { setSel(null); }, [kind, app, lang]);
  useEffect(() => { if (kind === 'other' && q.data && !q.data.otherEnabled) setKind('doc'); }, [kind, q.data]);

  async function copy(name: string) {
    setSel(name);
    try { await navigator.clipboard.writeText(name); setMsg({ ok: true, t: tr('{0} copied to the clipboard.', name) }); }
    catch { setMsg({ ok: false, t: tr('The browser did not allow copying. Select the tag and press Ctrl+C.') }); }
  }
  if (q.isLoading) return <PageLoader label={tr('Loading tags')} />;
  const d = q.data;
  const items = d?.items ?? [];
  return (
    <div className="um">
      <PageHero icon={<IconTag />} title={tr('Tags')} sub={tr('Tags are replaced by the current values when a document is published, previewed, viewed or printed ({0})', lang)}
        chips={[{ n: items.length, label: 'tags' }]} />
      <div className="card" style={{ padding: 16 }}>
        <div className="tag-kind" role="radiogroup" aria-label={tr('Tag type')}>
          <label className="fm-chk"><input type="radio" name="tk" checked={kind === 'doc'} onChange={() => setKind('doc')} /><span>{tr('Document Level Tags')}</span></label>
          <label className="fm-chk"><input type="radio" name="tk" checked={kind === 'app'} onChange={() => setKind('app')} /><span>{tr('Application Level Tags')}</span></label>
          <label className={`fm-chk ${d?.otherEnabled ? '' : 'off'}`} title={d?.otherEnabled ? '' : tr('Available when another product of the MS QDS family with tags is installed.')}>
            <input type="radio" name="tk" checked={kind === 'other'} disabled={!d?.otherEnabled} onChange={() => { setKind('other'); setApp(0); }} /><span>{tr('Other Application Tags/Links')}</span></label>
          {kind === 'other' && d && (
            <select value={app} onChange={e => setApp(Number(e.target.value))} aria-label={tr('Product')}>
              <option value={0}>{tr('All')}</option>{d.products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>)}
        </div>
        {q.error && <div className="alert">{(q.error as Error).message}</div>}
        {items.length === 0 && !q.error && <div className="mh" style={{ padding: 12 }}>{kind === 'app' ? tr('No application level tags yet. Create them under Options → Program options → Admin.') : tr('No tags found.')}</div>}
        {items.length > 0 && (
          <div className="um-scroll">
            <table className="grid-table tag-tbl"><thead><tr><th>{tr('Tag Name')}</th><th>{tr('Description')}</th>{kind === 'app' && <th>{tr('Replacement')}</th>}</tr></thead>
              <tbody>{items.map(t => (
                <tr key={`${t.app}-${t.id}-${t.name}`} className={sel === t.name ? 'sel' : ''} onClick={() => copy(t.name)} onDoubleClick={() => copy(t.name)} style={{ cursor: 'pointer' }}>
                  <td><code>{t.name}</code></td><td>{t.description}</td>{kind === 'app' && <td>{t.value}</td>}</tr>))}</tbody></table>
          </div>)}
        <small className="mh">{tr('Select a tag: it is copied to the clipboard. Paste it into the document in edit mode; it is replaced after the document is published.')}</small>
        <div className="modal-foot" style={{ marginTop: 10 }}>
          <button className="btn-primary" disabled={!sel} onClick={() => sel && copy(sel)}>{tr('Copy Tag')}</button>
          <button className="btn-ghost" onClick={() => nav('/documents')}>{tr('Close')}</button>
        </div>
      </div>
      <Toast msg={msg} onClose={() => setMsg(null)} />
    </div>
  );
}
