import { useCallback, useRef, useState } from 'react';
import { tr } from '../i18n';

/** Removes everything that could run code (the mail text is edited here and sent to other people). */
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<div id="r">${html}</div>`, 'text/html');
  const root = doc.getElementById('r');
  if (!root) return '';
  root.querySelectorAll('script,iframe,object,embed,link,meta,base,form,style').forEach(n => n.remove());
  root.querySelectorAll('*').forEach(el => {
    for (const a of Array.from(el.attributes)) {
      const n = a.name.toLowerCase();
      const v = a.value.replace(/\s+/g, '').toLowerCase();
      if (n.startsWith('on')) el.removeAttribute(a.name);
      else if ((n === 'href' || n === 'src' || n === 'xlink:href') && /^(javascript|vbscript|data:text\/html)/.test(v)) el.removeAttribute(a.name);
    }
  });
  return root.innerHTML;
}

/** Plain text of the header / footer block of the mail (saved with the document like the legacy "Add Email Address" window). */
export function blockText(html: string, name: 'header' | 'footer'): string {
  const doc = new DOMParser().parseFromString(`<div id="r">${html}</div>`, 'text/html');
  const el = doc.querySelector(`[data-pl="${name}"]`);
  if (!el) return '';
  el.querySelectorAll('br').forEach(b => b.replaceWith('\n'));
  el.querySelectorAll('p,div,li').forEach(b => b.append('\n'));
  return (el.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

const FONT_SIZES: [string, string][] = [['Small', '2'], ['Normal', '3'], ['Large', '5'], ['Huge', '6']];

/**
 * A small rich text editor (like the CKEditor window of other web apps) built on the browser's own editing support - no extra package.
 * The parent gives the start html and re-mounts the editor (key) to load another one; changes come back through onChange.
 */
export default function RichEditor({ html, onChange, minHeight = 300, maxHeight = 440 }: {
  html: string; onChange: (html: string) => void; minHeight?: number; maxHeight?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const value = useRef(html);
  const saved = useRef<Range | null>(null);
  const [source, setSource] = useState(false);
  const [src, setSrc] = useState('');
  const [link, setLink] = useState<string | null>(null);

  const mount = useCallback((el: HTMLDivElement | null) => {
    ref.current = el;
    if (el) {
      el.innerHTML = sanitizeHtml(value.current);
      try { document.execCommand('styleWithCSS', false, 'true'); } catch { /* not supported */ }
    }
  }, []);

  const emit = () => { const h = ref.current?.innerHTML ?? ''; value.current = h; onChange(h); };
  const exec = (cmd: string, arg?: string) => { ref.current?.focus(); document.execCommand(cmd, false, arg); emit(); };
  const keep = (e: React.MouseEvent) => e.preventDefault();      // clicking a button must not take the selection away from the text

  const saveSel = () => { const s = window.getSelection(); saved.current = s && s.rangeCount ? s.getRangeAt(0).cloneRange() : null; };
  const restoreSel = () => { const s = window.getSelection(); if (s && saved.current) { s.removeAllRanges(); s.addRange(saved.current); } };

  function applyLink() {
    const url = (link ?? '').trim();
    setLink(null);
    if (!url) return;
    ref.current?.focus(); restoreSel();
    document.execCommand('createLink', false, /^(https?:|mailto:|#)/i.test(url) ? url : 'https://' + url);
    emit();
  }

  function toggleSource() {
    if (!source) { setSrc(ref.current?.innerHTML ?? value.current); setSource(true); }
    else { value.current = src; onChange(src); setSource(false); }
  }

  const B = (title: string, label: React.ReactNode, onClick: () => void, extra = '') => (
    <button type="button" className={`re-btn ${extra}`} title={title} aria-label={title} onMouseDown={keep} onClick={onClick} disabled={source}>{label}</button>);

  return (
    <div className="re">
      <div className="re-bar" role="toolbar" aria-label={tr('Text formatting')}>
        {B('Undo', '↶', () => exec('undo'))}{B('Redo', '↷', () => exec('redo'))}
        <span className="re-sep" />
        <select className="re-sel" aria-label={tr('Paragraph style')} disabled={source} defaultValue="" onChange={e => { if (e.target.value) exec('formatBlock', e.target.value); e.target.value = ''; }}>
          <option value="">{tr('Style')}</option><option value="p">{tr('Paragraph')}</option><option value="h2">{tr('Heading')}</option><option value="h3">{tr('Sub-heading')}</option></select>
        <select className="re-sel" aria-label={tr('Font size')} disabled={source} defaultValue="" onChange={e => { if (e.target.value) exec('fontSize', e.target.value); e.target.value = ''; }}>
          <option value="">{tr('Size')}</option>{FONT_SIZES.map(([n, v]) => <option key={v} value={v}>{n}</option>)}</select>
        <span className="re-sep" />
        {B('Bold', <b>{tr('B')}</b>, () => exec('bold'))}{B('Italic', <i>{tr('I')}</i>, () => exec('italic'))}{B('Underline', <u>{tr('U')}</u>, () => exec('underline'))}{B('Strikethrough', <s>{tr('S')}</s>, () => exec('strikeThrough'))}
        <label className="re-clr" title={tr('Text colour')}><span>{tr('A')}</span>
          <input type="color" defaultValue="#1d4ed8" disabled={source} onMouseDown={saveSel} onChange={e => { restoreSel(); exec('foreColor', e.target.value); }} aria-label={tr('Text colour')} /></label>
        <label className="re-clr hl" title={tr('Highlight')}><span>▮</span>
          <input type="color" defaultValue="#fff3a3" disabled={source} onMouseDown={saveSel} onChange={e => { restoreSel(); exec('hiliteColor', e.target.value); }} aria-label={tr('Highlight colour')} /></label>
        <span className="re-sep" />
        {B(tr('Align left'), '⯇', () => exec('justifyLeft'))}{B('Centre', '≡', () => exec('justifyCenter'))}{B(tr('Align right'), '⯈', () => exec('justifyRight'))}
        <span className="re-sep" />
        {B(tr('Bullet list'), '•≡', () => exec('insertUnorderedList'))}{B(tr('Numbered list'), '1.', () => exec('insertOrderedList'))}
        {B(tr('Decrease indent'), '⇤', () => exec('outdent'))}{B(tr('Increase indent'), '⇥', () => exec('indent'))}
        <span className="re-sep" />
        {B(tr('Insert link'), '🔗', () => { saveSel(); setLink(''); })}{B(tr('Remove link'), '⛓', () => exec('unlink'))}
        {B(tr('Clear formatting'), 'Tx', () => exec('removeFormat'))}
        <span className="re-grow" />
        <button type="button" className={`re-btn txt ${source ? 'on' : ''}`} title={tr('Edit the HTML code')} onMouseDown={keep} onClick={toggleSource}>{'</>'} {tr('HTML')}</button>
      </div>
      {link !== null && (
        <div className="re-link">
          <input autoFocus placeholder={tr('https://…')} value={link} onChange={e => setLink(e.target.value)} aria-label={tr('Link address')}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); applyLink(); } if (e.key === 'Escape') setLink(null); }} />
          <button type="button" className="btn-primary" style={{ width: 'auto', padding: '6px 14px' }} onClick={applyLink}>{tr('Apply')}</button>
          <button type="button" className="btn-ghost" onClick={() => setLink(null)}>{tr('Cancel')}</button>
        </div>)}
      {source
        ? <textarea className="re-src" style={{ minHeight, maxHeight }} spellCheck={false} value={src} onChange={e => { setSrc(e.target.value); value.current = e.target.value; onChange(e.target.value); }} aria-label={tr('HTML code')} />
        : <div ref={mount} className="re-body" style={{ minHeight, maxHeight }} contentEditable suppressContentEditableWarning spellCheck
            role="textbox" aria-multiline="true" aria-label={tr('E-mail text')} onInput={emit} onBlur={emit}
            onPaste={e => {
              e.preventDefault();
              const h = e.clipboardData.getData('text/html'); const t = e.clipboardData.getData('text/plain');
              if (h) document.execCommand('insertHTML', false, sanitizeHtml(h)); else document.execCommand('insertText', false, t);
              emit();
            }} />}
    </div>
  );
}
