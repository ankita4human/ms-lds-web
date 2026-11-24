import { useMemo, useRef, useState, type DragEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, uploadDocument, type GroupNode, type Lang, type UploadResult } from '../api';
import { Spinner } from './Loader';
import VersionPicker, { type Ver } from './VersionPicker';

const ACCEPT = '.doc,.docx,.dot,.dotx,.xls,.xlsx,.xlsm,.ppt,.pptx,.pdf,.vsd,.vsdx,.txt';
const MAX = 100 * 1024 * 1024;

const MAX_FILES = 50;
type Item = { key: number; file: File; name: string; state: 'wait' | 'up' | 'done' | 'err'; pct: number; error?: string; result?: UploadResult };
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
      if (f.size > MAX) { bad.push(`${f.name} is larger than 100 MB`); continue; }
      if (!ACCEPT.split(',').includes('.' + (f.name.split('.').pop() ?? '').toLowerCase())) { bad.push(`${f.name}: file type not allowed`); continue; }
      ok.push({ key: ++seq, file: f, name: baseName(f.name), state: 'wait', pct: 0 });
    }
    setItems(cur => {
      const known = new Set(cur.map(c => `${c.file.name}|${c.file.size}`));
      const add = ok.filter(o => !known.has(`${o.file.name}|${o.file.size}`));
      const all = [...cur, ...add];
      if (all.length > MAX_FILES) { bad.push(`Only ${MAX_FILES} files at a time`); return all.slice(0, MAX_FILES); }
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
    if (!pending.length) { setErr('Please choose at least one file.'); return; }
    if (pending.some(i => !i.name.trim())) { setErr('Every document needs a name.'); return; }
    if (group === '') { setErr('Please choose a folder.'); return; }
    if (ver.v1 + ver.v2 + ver.v3 === 0) { setErr('The version must be at least 0.0.1.'); return; }
    setBusy(true); setErr('');
    let failed = 0;
    const results: UploadResult[] = items.filter(c => c.result).map(c => c.result!);
    for (const it of pending) {
      const fd = new FormData();
      fd.append('file', it.file); fd.append('name', it.name.trim()); fd.append('groupId', String(group));
      fd.append('lang', target); fd.append('uiLang', lang);
      fd.append('v1', String(ver.v1)); fd.append('v2', String(ver.v2)); fd.append('v3', String(ver.v3));
      if (chosenType !== '') fd.append('type', String(chosenType));
      patch(it.key, { state: 'up', pct: 0, error: undefined });
      try {
        const r = await uploadDocument(fd, p => patch(it.key, { pct: p }));
        patch(it.key, { state: 'done', pct: 100, result: r }); results.push(r);
      } catch (e) { failed++; patch(it.key, { state: 'err', error: (e as Error).message }); }
    }
    await Promise.all(['docs', 'groups', 'stats', 'doc-deep'].map(k => qc.invalidateQueries({ queryKey: [k] })));
    setBusy(false);
    if (failed === 0) onDone(results, wf && results.length === 1);
    else setErr(`${failed} document${failed === 1 ? '' : 's'} could not be uploaded. The others were created. Fix the problem and press Upload again to retry the failed ones.`);
  }

  return (
    <div className="modal-back" onMouseDown={() => !busy && onClose()}>
      <div className="modal" role="dialog" aria-label="New document" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head"><h3>New document{items.length > 1 ? 's' : ''}</h3><button className="x" onClick={onClose} disabled={busy} aria-label="Close">✕</button></div>

        <div className={`dropzone ${drag ? 'drag' : ''} ${items.length ? 'has' : ''}`}
          onClick={() => !busy && input.current?.click()} onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
          <input ref={input} type="file" accept={ACCEPT} multiple hidden onChange={e => pick(e.target.files)} />
          {items.length
            ? <><b>📎 {items.length} file{items.length === 1 ? '' : 's'} selected</b><small>Click or drop to add more · up to {MAX_FILES} at a time</small></>
            : <><b>⬆️ Drop files here or click to browse</b><small>One or many: Word, Excel, PowerPoint, PDF, Visio, text · max 100 MB each</small></>}
        </div>

        {items.length > 0 && (
          <div className="up-list" aria-label="Files to upload">
            {items.map(i => (
              <div key={i.key} className={`up-row ${i.state}`}>
                <span className="up-ic" aria-hidden="true">{i.state === 'done' ? '✓' : i.state === 'err' ? '!' : i.state === 'up' ? <span className="nb-spin" /> : '📄'}</span>
                <div className="up-main">
                  <input value={i.name} maxLength={80} disabled={busy || i.state === 'done'} onChange={e => patch(i.key, { name: e.target.value })} aria-label={`Name for ${i.file.name}`} placeholder="Document name" />
                  <small>{i.file.name} · {(i.file.size / 1024 / 1024).toFixed(2)} MB{i.state === 'done' && i.result ? ` · created as #${i.result.idDoc}` : ''}{i.state === 'err' ? ` · ${i.error}` : ''}</small>
                  {i.state === 'up' && <div className="up-bar"><i style={{ width: `${i.pct}%` }} /></div>}
                </div>
                {!busy && i.state !== 'done' && <button className="nb-x" onClick={() => setItems(cur => cur.filter(c => c.key !== i.key))} aria-label="Remove" title="Remove">×</button>}
              </div>
            ))}
          </div>
        )}

        <div className="mf">Language
          <div className="lang-pick">
            {languages.length > 1 && (
              <label className={target === 'ALL' ? 'on' : ''}><input type="radio" name="up-lang" checked={target === 'ALL'} onChange={() => setTarget('ALL')} />All languages</label>
            )}
            {languages.map(l => (
              <label key={l.lang} className={target === l.lang ? 'on' : ''}>
                <input type="radio" name="up-lang" checked={target === l.lang} onChange={() => setTarget(l.lang)} />{langName(l.lang)} ({l.lang})
              </label>
            ))}
          </div>
          <small className="mh">
            {target === 'ALL'
              ? 'The file is stored in the folder of every language.'
              : `The file is stored only in the ${langName(target)} folder; the other languages are marked as not required.`}
          </small>
        </div>

        <div className="mrow">
          <label className="mf">Document type
            <select value={chosenType} onChange={e => setType(e.target.value === '' ? '' : Number(e.target.value))}>
              {(types.data?.types ?? []).map(t => <option key={t.idType} value={t.idType}>{t.name}</option>)}
            </select>
          </label>
          <label className="mf">Folder (group)
            <select value={group} onChange={e => setGroup(e.target.value === '' ? '' : Number(e.target.value))}>
              <option value="">Select a folder...</option>
              {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>
        </div>

        <div className="mf">Version
          <VersionPicker value={ver} onChange={setVer} />
          <small className="mh">Every document is created in every language with this version, in Draft status.</small>
        </div>

        {canWorkflow && <label className="up-wf"><input type="checkbox" checked={wf} disabled={items.length > 1} onChange={e => setWf(e.target.checked)} />Choose a workflow for the new document after the upload{items.length > 1 ? ' (one document at a time)' : ''}</label>}

        {busy && <div className="up-progress"><span style={{ width: `${Math.round((doneCount / Math.max(1, items.length)) * 100)}%` }} /><em>Uploading {doneCount + 1} of {items.length}...</em></div>}
        {err && <div className="alert" role="alert">{err}</div>}

        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={busy || !pending.length}>{busy ? <><Spinner />Uploading</> : pending.length > 1 ? `Upload ${pending.length} documents` : 'Upload document'}</button>
        </div>
      </div>
    </div>
  );
}
