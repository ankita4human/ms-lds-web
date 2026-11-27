import { useEffect, useState } from 'react';
import { StatusBadge, ExtBadge, fmtDate } from './bits';
import type { Msg } from './assistantEngine';

/** Tiny markdown subset: **bold**, *italic*, `code`, "- " bullets, "1. " steps. */
export function Md({ text }: { text: string }) {
  const inline = (t: string, k: string) => t.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g).map((p, i) =>
    p.startsWith('**') && p.endsWith('**') && p.length > 4 ? <b key={k + i}>{p.slice(2, -2)}</b> : p.startsWith('`') && p.endsWith('`') && p.length > 2 ? <code key={k + i}>{p.slice(1, -1)}</code> : p.startsWith('*') && p.endsWith('*') && p.length > 2 ? <i key={k + i}>{p.slice(1, -1)}</i> : p);
  const out: React.ReactNode[] = []; let list: { ord: boolean; items: string[] } | null = null;
  const flush = () => { if (list) { const L = list; out.push(L.ord ? <ol key={out.length}>{L.items.map((x, i) => <li key={i}>{inline(x, 'o' + i)}</li>)}</ol> : <ul key={out.length}>{L.items.map((x, i) => <li key={i}>{inline(x, 'u' + i)}</li>)}</ul>); list = null; } };
  text.split('\n').forEach((ln, idx) => {
    const num = ln.match(/^\s*\d+\.\s+(.*)/), bul = ln.match(/^\s*[-•]\s+(.*)/);
    if (num) { if (!list || !list.ord) { flush(); list = { ord: true, items: [] }; } list.items.push(num[1]!); }
    else if (bul) { if (!list || list.ord) { flush(); list = { ord: false, items: [] }; } list.items.push(bul[1]!); }
    else { flush(); if (ln.trim()) out.push(<p key={'p' + idx}>{inline(ln, 'p' + idx)}</p>); }
  });
  flush();
  return <>{out}</>;
}

/** Text with [[matches]] marked by the search; shown highlighted. */
export function Snip({ text }: { text: string }) {
  return <>{text.split(/(\[\[.*?\]\])/g).map((p, i) => (p.startsWith('[[') ? <mark key={i}>{p.slice(2, -2)}</mark> : <span key={i}>{p}</span>))}</>;
}

export const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Reveals text progressively (typewriter) when `animate` is on; finished text is shown at once. */
export function Stream({ text, animate, onTick }: { text: string; animate: boolean; onTick?: () => void }) {
  const [n, setN] = useState(animate ? 0 : text.length);
  useEffect(() => {
    if (!animate) { setN(text.length); return; }
    let i = 0; const step = Math.max(2, Math.ceil(text.length / 90));
    const id = setInterval(() => { i = Math.min(text.length, i + step); setN(i); onTick?.(); if (i >= text.length) clearInterval(id); }, 16);
    return () => clearInterval(id);
  }, [text, animate]);   // eslint-disable-line react-hooks/exhaustive-deps
  return <Md text={n >= text.length ? text : text.slice(0, n) + ' ▍'.replace(' ', '')} />;
}

/** Everything a bot message can carry besides its text: filter chips, KPI tiles, tasks, documents, buttons and follow-up suggestions. */
export function MessageExtras({ m, go, ask, showFollow, busy }: { m: Msg; go: (to: string) => void; ask: (q: string) => void; showFollow: boolean; busy: boolean }) {
  return (
    <>
      {m.progress && <div className="ai-prog" aria-hidden="true"><i style={{ width: `${(m.progress.i / m.progress.n) * 100}%` }} /></div>}
      {m.chips && <div className="bot-chips">{m.chips.map(c => <span key={c}>{c}</span>)}</div>}
      {m.tiles && <div className="bot-kpis">{m.tiles.map(t => <button key={t.label} className={`k-${t.tone}`} onClick={() => go(t.to)}><b>{t.value}</b><small>{t.label}</small></button>)}</div>}
      {m.tasks && m.tasks.length > 0 && <div className="bot-results">{m.tasks.map(t => (
        <button key={t.taskId} className="bot-doc" onClick={() => go('/tasks')}>
          <div className="bot-doc-top"><b>#{t.idDoc}</b><span className="bot-step">{t.layerName || t.step}</span></div>
          <div className="bot-doc-name">{t.docName}</div>
          <div className="bot-doc-meta">{t.workflow} · {t.step}{t.due ? ` · due ${fmtDate(t.due)}` : ''}{t.overdue ? ' · overdue' : ''}</div>
        </button>))}</div>}
      {m.hits && m.hits.length > 0 && (
        <div className="bot-results">
          {m.hits.map(h => (
            <button key={`${h.idDoc}${h.lang}`} className="bot-doc hit" onClick={() => go(`/documents?doc=${h.idDoc}`)}>
              <div className="bot-doc-top"><span className="bot-doc-id"><ExtBadge ext={h.ext} compact /><b>#{h.idDoc} · v{h.version}</b></span><StatusBadge id={h.status} name={h.statusName} /></div>
              <div className="bot-doc-name">{h.docName}</div>
              {h.folder && <div className="bot-doc-meta">📁 {h.folder}</div>}
              <div className="bot-snip"><Snip text={h.snippet} /></div>
              <div className="bot-doc-meta">Click to open the folder and select this document</div>
            </button>
          ))}
        </div>
      )}
      {m.manual && m.manual.length > 0 && (
        <div className="bot-results">
          {m.manual.map((h, i) => (
            <div key={i} className="bot-man">
              <div className="bot-man-top"><span>📖 User manual</span><b>page {h.p}</b></div>
              <div className="bot-man-h">{h.h}</div>
              <div className="bot-snip"><Snip text={h.snippet} /></div>
            </div>
          ))}
        </div>
      )}
      {m.docs && m.docs.length > 0 && (
        <div className="bot-results">
          {m.docs.map(d => (
            <button key={`${d.idDoc}${d.lang}`} className="bot-doc" onClick={() => go(`/documents?doc=${d.idDoc}`)}>
              <div className="bot-doc-top"><b>#{d.idDoc}</b><StatusBadge id={d.status} name={d.statusName} /></div>
              <div className="bot-doc-name">{d.docName}</div>
              {d.paths && d.paths.length > 0 && (
                <div className="bot-doc-path" title={d.paths.join('\n')}>
                  📁 {d.paths[0]!.split(' / ').map((p, j, a) => <span key={j}>{p}{j < a.length - 1 && <em> › </em>}</span>)}
                  {d.paths.length > 1 && <small> +{d.paths.length - 1} more</small>}
                </div>
              )}
              <div className="bot-doc-meta">
                {d.publisher ? `Published by ${d.publisher}${d.datePub ? ' · ' + fmtDate(d.datePub) : ''}` : d.creator ? `Created by ${d.creator}` : ''}
                {d.releaser ? ` · Released by ${d.releaser}` : ''}
              </div>
            </button>
          ))}
          {m.query?.text && !m.query.creator && !m.query.publisher && !m.query.releaser && m.total! > m.docs.length && (
            <button className="bot-more" onClick={() => go(`/documents?q=${encodeURIComponent(m.query!.text!)}`)}>Open all {m.total} in Documents →</button>
          )}
        </div>
      )}
      {m.actions && <div className="bot-actions">{m.actions.map(a => <button key={a.to + a.label} onClick={() => go(a.to)}>{a.label} →</button>)}</div>}
      {showFollow && m.follow && !busy && <div className="bot-follow">{m.follow.map(f => <button key={f} onClick={() => ask(f)}>{f}</button>)}</div>}
    </>
  );
}
