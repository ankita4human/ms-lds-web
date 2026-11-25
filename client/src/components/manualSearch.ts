/* Offline search in the MS LDS user manual: BM25 over the passages in /manual.json, running in the browser (no server, no external model). */
export type ManualHit = { p: number; h: string; snippet: string; score: number; matched: number; total: number };
type Chunk = { p: number; h: string; t: string };
type Idx = { chunks: Chunk[]; tf: Map<string, number>[]; len: number[]; df: Map<string, number>; avg: number };

const STOP = new Set('the a an of for to in on is are was were be been do does did how what where when why which can could i you my me we it this that and or with without from by about please tell show explain need want would should as at if then than so not no yes into out up down over under'.split(' '));
export const stemW = (w: string) => w.replace(/(ing|ed|es|s)$/, '');
export const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9äöüß ]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !STOP.has(w)).map(stemW);

let idx: Promise<Idx | null> | null = null;
function load(): Promise<Idx | null> {
  return (idx ??= fetch('/manual.json').then(r => (r.ok ? (r.json() as Promise<Chunk[]>) : Promise.reject(new Error('manual'))))
    .then(chunks => {
      const tf = chunks.map(c => { const m = new Map<string, number>(); for (const t of [...tokens(c.t), ...tokens(c.h), ...tokens(c.h)]) m.set(t, (m.get(t) ?? 0) + 1); return m; });
      const len = tf.map(m => [...m.values()].reduce((a, b) => a + b, 0));
      const df = new Map<string, number>(); for (const m of tf) for (const k of m.keys()) df.set(k, (df.get(k) ?? 0) + 1);
      return { chunks, tf, len, df, avg: len.reduce((a, b) => a + b, 0) / Math.max(1, len.length) };
    }).catch(() => null));
}

function snippet(text: string, qs: string[]): string {
  const low = text.toLowerCase(); let at = -1;
  for (const q of qs) { const i = low.search(new RegExp('\\b' + q.replace(/[^a-z0-9äöüß]/g, ''), 'i')); if (i >= 0 && (at < 0 || i < at)) at = i; }
  const from = Math.max(0, (at < 0 ? 0 : at) - 70), to = Math.min(text.length, from + 260);
  let s = text.slice(from, to).trim();
  for (const q of new Set(qs)) { const re = new RegExp('\\b(' + q.replace(/[^a-z0-9äöüß]/g, '') + '[a-zäöüß]*)', 'gi'); s = s.replace(re, '[[$1]]'); }
  s = s.replace(/\]\]\s*\[\[/g, ' ');
  return (from > 0 ? '… ' : '') + s + (to < text.length ? ' …' : '');
}

export async function searchManual(query: string, limit = 3): Promise<ManualHit[]> {
  const ix = await load(); if (!ix) return [];
  const qs = [...new Set(tokens(query))]; if (!qs.length) return [];
  const N = ix.chunks.length, k1 = 1.4, b = 0.75;
  const res: (ManualHit & { i: number })[] = [];
  ix.chunks.forEach((c, i) => {
    let score = 0, matched = 0;
    for (const q of qs) {
      const f = ix.tf[i]!.get(q) ?? 0; if (!f) continue;
      matched++; const df = ix.df.get(q) ?? 0;
      score += Math.log(1 + (N - df + 0.5) / (df + 0.5)) * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (ix.len[i]! / ix.avg))));
    }
    if (matched) res.push({ i, p: c.p, h: c.h, snippet: '', score: score * (0.6 + 0.4 * (matched / qs.length)), matched, total: qs.length });
  });
  res.sort((x, y) => y.score - x.score);
  return res.slice(0, limit).map(({ i, ...h }) => ({ ...h, snippet: snippet(ix.chunks[i]!.t, qs) }));
}
/** A hit is trusted when most of the question words are in the passage. */
export const confident = (h?: ManualHit) => !!h && h.matched >= Math.max(1, Math.ceil(h.total * 0.6)) && h.score > 2.2;
