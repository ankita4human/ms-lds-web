import { useMemo, useRef, useState, type DragEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, uploadDocument, type GroupNode, type Lang, type UploadResult } from '../api';
import { Spinner } from './Loader';
import VersionPicker, { type Ver } from './VersionPicker';
import { ExtBadge } from './bits';
import { tr } from '../i18n';

const ACCEPT = '.doc,.docx,.dot,.dotx,.xls,.xlsx,.xlsm,.ppt,.pptx,.pdf,.vsd,.vsdx,.txt';
const MAX = 100 * 1024 * 1024;

const MAX_FILES = 50;
type Item = { key: number; file: File; name: string; type: number | ''; state: 'wait' | 'up' | 'done' | 'err'; pct: number; error?: string; result?: UploadResult };
const CONCURRENCY = 3;
const size = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
let seq = 0;
const baseName = (n: string) => n.replace(/\.[^.]+$/, '').slice(0, 80);

/** "New document": choose one or many files, language (one or all), type, folder and version, then upload them one after the other. */
export default function UploadDialog({ groups, defaultGroup, lang, languages, onClose, onDone, canWorkflow }: {
  groups: GroupNode[]; defaultGroup: number | null; lang: string; languages: Lang[];
  onClose: () => void; onDone: (r: UploadResult[], chooseWorkflow?: boolean) => void; canWorkflow?: boolean;
}) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [target, setTarget] = useState<string>(languages.length > 1 ? 'ALL' : (languages[0]?.lang ?? lang));
  const [type, setType] = useState<number | ''>('');
  const [group, setGroup] = useState<number | ''>(defaultGroup ?? '');
  const [ver, setVer] = useState<Ver>({ v1: 0, v2: 0, v3: 1 });   // manual: default 0.0.1
  const [wf, setWf] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [drag, setDrag] = useState(false);
  const [folderQ, setFolderQ] = useState('');

  const types = useQuery({ queryKey: ['doctypes', lang], queryFn: () => api.docTypes(lang), enabled: !!lang, staleTime: 30 * 60_000 });
  const chosenType = type === '' ? (types.data?.defaultType ?? '') : type;

  // Only folders the user may use, shown with their full path.
  const options = useMemo(() => {
    const byId = new Map(groups.map(g => [g.idGroup, g]));
    const path = (g: GroupNode) => { const p: string[] = []; let c: GroupNode | undefined = g, n = 0; while (c && n++ < 50) { p.unshift(c.name); c = byId.get(c.idParent); } return p.join(' / '); };
    return groups.filter(g => g.accessible).map(g => ({ id: g.idGroup, label: path(g) })).sort((a, b) => a.label.localeCompare(b.label));
  }, [groups]);

  function pick(list: FileList | File[] | null | undefined) {
    setErr('');
    const files = Array.from(list ?? []); if (!files.length) return;
    const bad: string[] = []; const ok: Item[] = [];
    for (const f of files) {
      if (f.size > MAX) { bad.push(tr('{0} is larger than 100 MB', f.name)); continue; }
      if (!ACCEPT.split(',').includes('.' + (f.name.split('.').pop() ?? '').toLowerCase())) { bad.push(`${f.name}: file type not allowed`); continue; }
      ok.push({ key: ++seq, file: f, name: baseName(f.name), type: '', state: 'wait', pct: 0 });
    }
    setItems(cur => {
      const known = new Set(cur.map(c => `${c.file.name}|${c.file.size}`));
      const add = ok.filter(o => !known.has(`${o.file.name}|${o.file.size}`));
      const all = [...cur, ...add];
      if (all.length > MAX_FILES) { bad.push(tr('Only {0} files at a time', MAX_FILES)); return all.slice(0, MAX_FILES); }
      return all;
    });
    if (bad.length) setErr(bad.slice(0, 3).join('. ') + (bad.length > 3 ? ` (+${bad.length - 3} more)` : '') + '.');
    if (input.current) input.current.value = '';
  }
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); if (!busy) pick(e.dataTransfer.files); };
  const langName = (l: string) => languages.find(x => x.lang === l)?.name ?? l;
  const patch = (key: number, p: Partial<Item>) => setItems(cur => cur.map(i => (i.key === key ? { ...i, ...p } : i)));
  const pending = items.filter(i => i.state !== 'done');
  const doneCount = items.filter(i => i.state === 'done').length;

  async function submit() {
    if (!pending.length) { setErr(tr('Please choose at least one file.')); return; }
    if (pending.some(i => !i.name.trim())) { setErr(tr('Every document needs a name.')); return; }
    if (group === '') { setErr(tr('Please choose a folder.')); return; }
    if (ver.v1 + ver.v2 + ver.v3 === 0) { setErr(tr('The version must be at least 0.0.1.')); return; }
    setBusy(true); setErr('');
    let failed = 0;
    const results: UploadResult[] = items.filter(c => c.result).map(c => c.result!);
    const queue = [...pending]; let next = 0;
    async function one(it: Item) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const fd = new FormData();
        fd.append('file', it.file); fd.append('name', it.name.trim()); fd.append('groupId', String(group));
        fd.append('lang', target); fd.append('uiLang', lang);
        fd.append('v1', String(ver.v1)); fd.append('v2', String(ver.v2)); fd.append('v3', String(ver.v3));
        const t = it.type !== '' ? it.type : chosenType;
        if (t !== '') fd.append('type', String(t));
        patch(it.key, { state: 'up', pct: 0, error: undefined });
        try {
          const r = await uploadDocument(fd, p => patch(it.key, { pct: p }));
          patch(it.key, { state: 'done', pct: 100, result: r }); results.push(r); return;
        } catch (e) {
          const m = (e as Error).message;
          if (attempt === 1 && /deadlock|timeout|temporar|network/i.test(m)) continue;   // one automatic retry for transient problems
          failed++; patch(it.key, { state: 'err', error: m }); return;
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => { while (next < queue.length) await one(queue[next++]!); }));
    await Promise.all(['docs', 'groups', 'stats', 'doc-deep'].map(k => qc.invalidateQueries({ queryKey: [k] })));
    setBusy(false);
    if (failed === 0) onDone(results, wf && results.length === 1);
    else setErr(tr('{0} document{1} could not be uploaded. The others were created. Fix the problem and press Upload again to retry the failed ones.', failed, failed === 1 ? '' : 's'));
  }

  const totalBytes = items.reduce((n, i) => n + i.file.size, 0);
  const folderLabel = options.find(o => o.id === group)?.label ?? '';
  const filteredOptions = folderQ.trim() ? options.filter(o => o.label.toLowerCase().includes(folderQ.trim().toLowerCase())) : options;
  const overall = items.length ? Math.round(items.reduce((n, i) => n + (i.state === 'done' ? 100 : i.state === 'up' ? i.pct : 0), 0) / items.length) : 0;

  return (
    <div className="modal-back" onMouseDown={() => !busy && onClose()}>
      <div className="modal upx" role="dialog" aria-label={tr('New document')} onMouseDown={e => e.stopPropagation()}>
        <div className="upx-banner">
          <span className="upx-banner-ico" aria-hidden="true">📄</span>
          <div><h3>{tr('New document')}{items.length > 1 ? 's' : ''}</h3><small>{tr('Upload one or many files at once, they are created in all languages')}</small></div>
          <button className="x" onClick={onClose} disabled={busy} aria-label={tr('Close')}>✕</button>
        </div>

        <div className="upx-body">
          <section className="upx-left">
            <div className={`upx-drop ${drag ? 'drag' : ''} ${items.length ? 'has' : ''}`} role="button" tabIndex={0} aria-label={tr('Choose files')}
              onClick={() => !busy && input.current?.click()} onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && !busy) { e.preventDefault(); input.current?.click(); } }}
              onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
              <input ref={input} type="file" accept={ACCEPT} multiple hidden onChange={e => pick(e.target.files)} />
              <span className="upx-cloud" aria-hidden="true"><svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V4" /><path d="M7 9l5-5 5 5" /><path d="M20 16v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3" /></svg></span>
              {items.length
                ? <><b>{drag ? tr('Drop to add more files') : tr('Add more files')}</b><small>{items.length} {tr('selected ·')}{' '}{size(totalBytes)} {tr('· up to')}{' '}{MAX_FILES} {tr('at a time')}</small></>
                : <><b>{drag ? tr('Release to add your files') : tr('Drag & drop your files here')}</b><small>{tr('or click to browse · 100 MB per file')}</small>
                  <span className="upx-types" aria-hidden="true">{['docx', 'xlsx', 'pptx', 'pdf', 'vsdx', 'txt'].map(x => <ExtBadge key={x} ext={x} />)}</span>
                  <span className="upx-perks"><span>{tr('⚡ Up to')}{' '}{MAX_FILES} {tr('files at once')}</span><span>{tr('🌍 Created in every language')}</span><span>{tr('🏷️ Name taken from the file, editable')}</span></span></>}
            </div>

            {items.length > 0 && (
              <div className="upx-files" aria-label={tr('Files to upload')}>
                {items.map(i => (
                  <div key={i.key} className={`upx-file ${i.state}`}>
                    <ExtBadge ext={i.file.name.split('.').pop()} />
                    <div className="upx-file-main">
                      <input value={i.name} maxLength={80} disabled={busy || i.state === 'done'} onChange={e => patch(i.key, { name: e.target.value })} aria-label={tr('Name for {0}', i.file.name)} placeholder={tr('Document name')} />
                      <small>{i.file.name} · {size(i.file.size)}
                        {i.state === 'done' && i.result ? <b className="ok"> {tr('· created as #')}{i.result.idDoc}</b> : null}
                        {i.state === 'err' ? <b className="bad"> · {i.error}</b> : null}</small>
                      {i.state === 'up' && <div className="upx-bar"><i style={{ width: `${i.pct}%` }} /></div>}
                    </div>
                    {i.state === 'wait' || i.state === 'err' ? (
                      <select className="upx-type" value={i.type} disabled={busy} onChange={e => patch(i.key, { type: e.target.value === '' ? '' : Number(e.target.value) })} aria-label={tr('Type for {0}', i.file.name)} title={tr('Document type of this file')}>
                        <option value="">{tr('Default type')}</option>{(types.data?.types ?? []).map(t => <option key={t.idType} value={t.idType}>{t.name}</option>)}</select>) : null}
                    <span className="upx-state" aria-hidden="true">{i.state === 'done' ? '✓' : i.state === 'err' ? '!' : i.state === 'up' ? <span className="nb-spin" /> : ''}</span>
                    {!busy && i.state !== 'done' && <button className="nb-x" onClick={() => setItems(cur => cur.filter(c => c.key !== i.key))} aria-label={tr('Remove')} title={tr('Remove')}>×</button>}
                  </div>
                ))}
              </div>
            )}
          </section>

          <aside className="upx-right">
            <div className="upx-sec"><span className="upx-n">1</span><b>{tr('Language')}</b></div>
            <div className="lang-pick upx-pills">
              {languages.length > 1 && <label className={target === 'ALL' ? 'on' : ''}><input type="radio" name="up-lang" checked={target === 'ALL'} onChange={() => setTarget('ALL')} />{tr('All languages')}</label>}
              {languages.map(l => (
                <label key={l.lang} className={target === l.lang ? 'on' : ''}><input type="radio" name="up-lang" checked={target === l.lang} onChange={() => setTarget(l.lang)} />{langName(l.lang)} ({l.lang})</label>))}
            </div>
            <small className="mh">{target === 'ALL' ? tr('The file is stored in the folder of every language.') : tr('Stored only in the {0} folder; the other languages are marked as not required.', langName(target))}</small>

            <div className="upx-sec"><span className="upx-n">2</span><b>{tr('Type and folder')}</b></div>
            <label className="mf">{tr('Document type')}<select value={chosenType} onChange={e => setType(e.target.value === '' ? '' : Number(e.target.value))}>
                {(types.data?.types ?? []).map(t => <option key={t.idType} value={t.idType}>{t.name}</option>)}</select></label>
            <label className="mf">{tr('Folder (group)')}<input className="upx-fq" value={folderQ} onChange={e => setFolderQ(e.target.value)} placeholder={tr('Search folders…')} aria-label={tr('Search folders')} />
              <select value={group} size={9} onChange={e => setGroup(e.target.value === '' ? '' : Number(e.target.value))} className="upx-folders">
                {filteredOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label>

            <div className="upx-sec"><span className="upx-n">3</span><b>{tr('Version')}</b></div>
            <VersionPicker value={ver} onChange={setVer} />
            <small className="mh">{tr('Every document is created in every language with this version, in Draft status.')}</small>

            {canWorkflow && <label className="up-wf"><input type="checkbox" checked={wf} disabled={items.length > 1} onChange={e => setWf(e.target.checked)} />{tr('Choose a workflow after the upload')}{items.length > 1 ? tr(' (one document at a time)') : ''}</label>}
          </aside>
        </div>

        {busy && <div className="upx-progress" role="progressbar" aria-valuenow={overall} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${overall}%` }} /><em>{tr('Uploading')}{' '}{Math.min(doneCount + 1, items.length)} {tr('of')}{' '}{items.length} · {overall}%</em></div>}
        {err && <div className="alert" role="alert" style={{ margin: '0 20px' }}>{err}</div>}

        <div className="upx-foot">
          <div className="upx-sum" aria-live="polite">
            {items.length > 0
              ? <><b>{items.length}</b> {tr('document')}{items.length === 1 ? '' : 's'} · {size(totalBytes)}{folderLabel && <> · <span title={folderLabel}>📁 {folderLabel.split(' / ').slice(-1)[0]}</span></>} {tr('· v')}{ver.v1}.{ver.v2}.{ver.v3}</>
              : <span className="mh">{tr('No file chosen yet')}</span>}
          </div>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
          <button className="btn-primary upx-go" onClick={submit} disabled={busy || !pending.length}>{busy ? <><Spinner />{tr('Uploading')}</> : pending.length > 1 ? tr('Upload {0} documents', pending.length) : tr('Upload document')}</button>
        </div>
      </div>
    </div>
  );
}
