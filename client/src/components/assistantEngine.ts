import { api, type ContentItem, type DocQuery, type DocRow, type Stats, type WfSummary } from '../api';
import { confident, searchManual, type ManualHit } from './manualSearch';
import { KB, lookup, fixTypos, type Kb } from './chatKnowledge';
import { tr, untr } from '../i18n';

/* ---------- Prompt understanding (rule based, runs in the browser; no external AI service) ---------- */
const STATUS: [RegExp, number, string][] = [
  [/\bdrafts?\b/, 1, 'Draft'], [/\b(in edit|editing|in progress)\b/, 2, 'Edit'], [/\bpublished\b/, 3, 'Published'],
  [/\bpresent\b/, 4, 'Present'], [/\barchived?\b/, 5, 'Archived'], [/\bverified\b/, 7, 'Verified'],
  [/\breleased\b/, 8, 'Released'], [/\bblocked\b/, 9, 'Blocked'], [/\bfrozen\b/, 11, 'Frozen'],
];
const FILLER = new Set(('show me list find search get give all the a an of for with documents document docs doc files file please ' +
  'which are is that who whose have has had status named called name containing contains about on in by from to and or my me i what how many count total number').split(' '));

type Parsed = { q: DocQuery; chips: string[]; countOnly: boolean; help: boolean; idOnly?: number };

export function parsePrompt(raw: string, me: string): Parsed {
  let t = ' ' + raw.toLowerCase().replace(/[?!]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
  const q: DocQuery = { page: 1, pageSize: 8, sort: 'modified', desc: true };
  const chips: string[] = [];
  const take = (re: RegExp) => { const m = t.match(re); if (m) t = t.replace(m[0], ' '); return m; };
  if (/^\s*(help|\?|what can you do)\s*$/.test(t)) return { q, chips, countOnly: false, help: true };

  const countOnly = /\b(how many|count|number of|total)\b/.test(t);

  // document id: "id 123", "doc #123", "document 123", or a bare number
  const idm = take(/\b(?:id|doc|document|no\.?|#)\s*[:#]?\s*(\d{1,9})\b/) ?? take(/^\s*#?(\d{1,9})\s*$/);
  if (idm) { q.text = idm[1]; chips.push(`ID ${idm[1]}`); return { q, chips, countOnly, help: false, idOnly: Number(idm[1]) }; }

  // people: "published by X", "released by X", "created/authored/written by X"
  const person = (verbs: string) => take(new RegExp(`\\b(?:${verbs})\\s+by\\s+(me|[\\w.\\-@]+)`));
  const pub = person('published|publish'), rel = person('released|release'), cre = person('created|authored|written|made|uploaded|owned');
  const who = (v: string) => (v === 'me' ? me : v);
  if (pub) { q.publisher = who(pub[1]); chips.push(tr('Publisher: {0}', q.publisher)); }
  if (rel) { q.releaser = who(rel[1]); chips.push(tr('Releaser: {0}', q.releaser)); }
  if (cre) { q.creator = who(cre[1]); chips.push(tr('Creator: {0}', q.creator)); }
  // "by X" alone, or "my documents"
  const by = take(/\bby\s+(me|[\w.\-@]+)/);
  const mine = !by && take(/\b(my|mine)\b/);
  const person2 = by ? who(by[1]) : mine ? me : undefined;

  // status words
  for (const [re, id, name] of STATUS) if (re.test(t)) { q.status = id; chips.push(tr('Status: {0}', name)); t = t.replace(re, ' '); break; }
  if (/\b(expired|overdue|out of date)\b/.test(t)) { q.expired = true; chips.push(tr('Expired')); t = t.replace(/\b(expired|overdue|out of date)\b/, ' '); }

  if (person2) {
    if (q.status === 3 && !q.publisher) { q.publisher = person2; chips.push(tr('Publisher: {0}', person2)); }
    else if (q.status === 8 && !q.releaser) { q.releaser = person2; chips.push(tr('Releaser: {0}', person2)); }
    else if (!q.creator && !q.publisher && !q.releaser) { q.creator = person2; chips.push(tr('Creator: {0}', person2)); }
  }

  // free text: a quoted phrase wins, otherwise whatever is left after removing filler words
  const quoted = raw.match(/["“'](.+?)["”']/);
  let text = quoted ? quoted[1] : t.split(' ').filter(w => w && !FILLER.has(w)).join(' ');
  text = text.trim();
  if (text) { q.text = text; chips.push(tr('Name contains “{0}”', text)); }
  return { q, chips, countOnly, help: false };
}


/* ---------- Conversation engine (local, rule based: no external model) ---------- */
export type Action = { label: string; to: string };
export type Tile = { label: string; value: number | string; tone: string; to: string };
export type Reply = {
  text?: string; chips?: string[]; docs?: DocRow[]; total?: number; query?: DocQuery; actions?: Action[]; follow?: string[];
  tiles?: Tile[]; tasks?: WfSummary['items']; progress?: { i: number; n: number }; navigate?: string; hits?: ContentItem[]; manual?: ManualHit[];
};
export type Msg = Reply & { id: number; from: 'bot' | 'me'; time: number; fb?: 'up' | 'down' };
/** What the assistant remembers inside one conversation. */
export type Ctx = { topic?: string; guide?: { id: string; i: number }; asked?: number; name?: string };
export type Env = { lang: string; name: string; short: string };

const NAV: [RegExp, string, string, string][] = [
  [/\b(dashboard|home)\b/, '/', 'Dashboard', 'the **Dashboard** entry in the left menu'],
  [/\banalytics\b/, '/analytics', 'Analytics', 'the **Analytics** entry in the left menu'],
  [/\b(documents?|document list)\b/, '/documents', 'Documents', 'the **Documents** entry in the left menu'],
  [/\b(my )?tasks?\b/, '/tasks', 'My tasks', 'the **My tasks** entry in the left menu'],
  [/\bfilter management|filters\b/, '/options/filters', 'Filter management', '**Options → Filter management**'],
  [/\btype management|document types?\b/, '/options/types', 'Type management', '**Options → Type management**'],
  [/\bstandards?\b/, '/options/standards', 'Standard management', '**Options → Standard management**'],
  [/\bdependenc(y|ies)\b/, '/options/dependency', 'Dependency', '**Options → Dependency**'],
  [/\busers?( management)?\b/, '/options/users', 'User management', '**Options → User management**'],
  [/\bworkflows?( management)?\b/, '/options/workflows', 'Workflow management', '**Options → Workflow management**'],
  [/\bcatch( management|words?)?\b/, '/options/catch', 'Catch management', '**Options → Catch management**'],
  [/\btags?\b/, '/options/tags', 'Tags', '**Options → Tags**'],
  [/\bprogram options?|admin options?|broken links?|web history|deleted documents?\b/, '/options/program', 'Program options', '**Options → Program options → Admin**'],
  [/\b(e-?mail )?distribution\b/, '/options/distribution', 'E-mail distribution', '**Options → E-mail distribution**'],
  [/\b(ai |assistant|chat)\b/, '/assistant', 'AI Assistant', 'the **AI Assistant** entry in the left menu'],
];
export const isQuestion = (t: string) => /\b(how|what|why|where|when|can i|could i|steps?|explain|meaning|mean|difference|help me|tell me|guide|procedure|process)\b/i.test(t) || t.trim().endsWith('?');
const SYN: [RegExp, string][] = [[/\bwf\b/g, 'workflow'], [/\bapprov(e|al|ing)\b/g, 'verify'], [/\bsign[- ]?off\b/g, 'verify'], [/\bgo live\b/g, 'publish'], [/\bdocs\b/g, 'documents'], [/\bdoc\b/g, 'document']];
const LEAD = ['Sure!', 'Good question.', 'Happy to explain.', 'Here is how it works.'];
const CHAIN = ['new', 'edit', 'verify', 'release', 'publish'];
const byId = (id?: string) => KB.find(e => e.id === id);
const stepsOf = (e: Kb) => e.a.split('\n').map(l => l.match(/^\s*\d+\.\s+(.*)/)?.[1]).filter((x): x is string => !!x);

function answer(e: Kb, ctx: Ctx, lead = false): Reply {
  ctx.topic = e.id; ctx.guide = undefined;
  const follow = [...(e.more ?? [])];
  if (stepsOf(e).length >= 2) follow.push(tr('Walk me through it'));
  if (e.detail) follow.push(tr('Tell me more'));
  return { text: (lead ? LEAD[(ctx.asked ?? 0) % LEAD.length] + '\n\n' : '') + e.a, actions: e.go ? [e.go] : undefined, follow: follow.slice(0, 4) };
}

function guideStep(e: Kb, i: number, ctx: Ctx): Reply {
  const st = stepsOf(e); const n = st.length; ctx.guide = { id: e.id, i }; ctx.topic = e.id;
  const last = i >= n - 1;
  return {
    text: tr('**Step {0} of {1}**\n{2}{3}', i + 1, n, st[i], last ? tr('\n\nThat was the last step. ✅ Anything else?') : ''), progress: { i: i + 1, n },
    actions: last && e.go ? [e.go] : undefined, follow: last ? [tr('Give me an overview'), tr('Show my pending tasks')] : [i > 0 ? tr('Back') : tr('Stop'), tr('Next'), tr('Stop')].filter((x, k, a) => a.indexOf(x) === k),
  };
}


// ---------- knowledge search: the text inside the documents (server index) and the user manual (offline) ----------
const clean = (t: string) => t.replace(/^["“'‘]+|["”'’?.!]+$/g, '').replace(/\s+/g, ' ').trim();
/** Pulls the search term out of "which documents mention X", "search X in my documents", "find the text X"… */
function contentTerm(raw: string): { term: string; scope: 'docs' | 'manual' | 'both' } | null {
  const t = raw.trim().replace(/\s+/g, ' ');
  let m = t.match(/^(?:please )?(?:search|find|look)(?: up| for)?\s+(.+?)\s+(?:in|inside|within|from|across)\s+(?:the\s+|my\s+|all\s+|our\s+)?(?:user\s+)?(manual|guide|handbook)\b/i);
  if (m) return { term: clean(m[1]!), scope: 'manual' };
  m = t.match(/^(?:please )?(?:search|find|look)(?: up| for)?\s+(?:the\s+)?(?:manual|guide|handbook)\s*(?:for|about|on|:)?\s*(.+)$/i) ?? t.match(/^(?:in|from) the (?:user )?(?:manual|guide)[,:]?\s*(.+)$/i);
  if (m) return { term: clean(m[1]!), scope: 'manual' };
  m = t.match(/^(?:please )?(?:search|find|look)(?: up| for)?\s+(.+?)\s+(?:in|inside|within|across)\s+(?:the\s+|my\s+|all\s+|our\s+)?(?:documents?|docs?|files?|content|text|texts|knowledge ?base|kb)\b/i);
  if (m) return { term: clean(m[1]!), scope: 'docs' };
  m = t.match(/\b(?:which|what|any|are there)\s+(?:documents?|docs?|files?)\s+(?:that\s+)?(?:mention|mentions|contain|contains|include|includes|talk(?:s)? about|say|says|describe|describes|have|has)\s+(.+)$/i)
    ?? t.match(/\b(?:in which|where in)\s+(?:documents?|docs?)\b.*?\b(?:is|are|does|do)\s+(.+?)\s+(?:mentioned|described|written|stated|explained|used|found)\b/i)
    ?? t.match(/\bwhere\s+(?:is|are|does)\s+(.+?)\s+(?:mentioned|described|written|stated|explained|used|found)\b/i);
  if (m) return { term: clean(m[1]!), scope: 'both' };
  m = t.match(/\b(?:full[- ]?text|content search|text search|search (?:the )?(?:content|text)|knowledge ?base)\b\s*(?:search\s+)?(?:for|of|on|about|:)?\s*(.+)$/i)
    ?? t.match(/^(?:please )?(?:search|find|look)(?: up| for)?\s+(?:the\s+)?(?:text|word|words|phrase|sentence|term)\s+(.+?)(?:\s+in\s+.*)?$/i);
  if (m) return { term: clean(m[1]!), scope: 'both' };
  return null;
}

/** Looks in the document texts and the manual. Returns null when neither has anything convincing. */
async function knowledge(term: string, env: Env, scope: 'docs' | 'manual' | 'both', ctx: Ctx, lead?: string): Promise<Reply | null> {
  const [docs, man] = await Promise.all([
    scope === 'manual' ? Promise.resolve(null) : api.searchContent(term, env.lang, 6).catch(() => null),
    scope === 'docs' ? Promise.resolve([] as ManualHit[]) : searchManual(term, 3),
  ]);
  const hits = docs?.items ?? [];
  const mh = (man ?? []).filter((h, i) => i === 0 ? confident(h) || scope === 'manual' : confident(h));
  if (!hits.length && !mh.length) return null;
  ctx.topic = undefined;
  const parts: string[] = [];
  if (lead) parts.push(lead);
  if (hits.length) parts.push(tr('**{0}{1}** document{2} match “{3}” (in the text or by catchword). The best matches are first:', hits.length, hits.length >= 6 ? '+' : '', hits.length === 1 ? '' : 's', term));
  if (mh.length) parts.push(tr(hits.length ? 'And the **user manual** has {0} on this:' : 'The **user manual** has {0} on this:', mh.length === 1 ? tr('a passage') : tr('passages')));
  return { text: parts.join('\n\n'), hits: hits.length ? hits : undefined, manual: mh.length ? mh : undefined, follow: hits.length ? [tr('Give me an overview')] : undefined };
}

async function emptyIndexNote(): Promise<string> {
  const s = await api.searchStatus().catch(() => null);
  if (!s) return '';
  if (s.documents === 0) return s.running ? tr(' The document index is being built right now, try again in a few minutes.') : tr(' The document index is still empty{0}. An administrator can say “rebuild the search index”.', s.note ? ' (' + s.note + ')' : '');
  return tr(' (I searched {0} indexed documents{1}.)', s.documents, s.running ? tr(', the index is still being updated') : '');
}

const WELCOME_FOLLOW = ['Show my pending tasks', 'Give me an overview', 'How do I add a document?'];

export async function respond(raw: string, env: Env, ctx: Ctx): Promise<Reply> {
  ctx.asked = (ctx.asked ?? 0) + 1;
  const original = untr(raw.trim());
  let low = original.toLowerCase().replace(/\s+/g, ' ');
  const first = (ctx.name || env.name || env.short || '').split(/[ ,]/)[0] ?? '';

  // ---- an open step-by-step guide ----
  if (ctx.guide) {
    const e = byId(ctx.guide.id);
    if (e) {
      if (/^(next|continue|go on|ok|okay|done|yes|y|weiter|next step|and then|then)\b/.test(low)) return guideStep(e, Math.min(ctx.guide.i + 1, stepsOf(e).length - 1), ctx);
      if (/^(back|previous|prev|go back|step back)\b/.test(low)) return guideStep(e, Math.max(ctx.guide.i - 1, 0), ctx);
      if (/^(repeat|again|once more)\b/.test(low)) return guideStep(e, ctx.guide.i, ctx);
      if (/^(stop|cancel|quit|exit|end|enough)\b/.test(low)) { ctx.guide = undefined; return { text: tr('Okay, I stopped the walk-through. Ask me anything else.'), follow: WELCOME_FOLLOW }; }
    }
  }

  // ---- small talk ----
  const nm = low.match(/\b(?:my name is|i am|i\'m|call me)\s+([a-zäöüß][\w\-]{1,20})\b/);
  if (nm && !/\b(looking|trying|new|not|unable|having|stuck)\b/.test(low)) { ctx.name = nm[1]!.replace(/^./, c => c.toUpperCase()); return { text: tr('Nice to meet you, **{0}**! What shall we do?', ctx.name), follow: WELCOME_FOLLOW }; }
  if (/^(hi|hello|hey|hallo|moin|servus|good (morning|afternoon|evening)|yo)\b/.test(low) && low.split(' ').length <= 4) {
    const h = new Date().getHours(); const g = h < 12 ? tr('Good morning') : h < 18 ? tr('Good afternoon') : tr('Good evening');
    return { text: tr('{0}{1}! 👋 I am your MS LDS assistant. I can find documents, show your tasks, walk you through a function step by step or take you to a page.', g, first ? ', ' + first : ''), follow: WELCOME_FOLLOW };
  }
  if (/^(thanks|thank you|thx|ty|great|perfect|super|danke|cool|nice|awesome|brilliant)\b/.test(low)) return { text: tr('You are welcome! 😊 Anything else I can do?'), follow: [tr('Give me an overview'), tr('Show my pending tasks')] };
  if (/^(bye|goodbye|see you|ciao|tschüss|good night)\b/.test(low)) return { text: tr('Goodbye{0}! I am here whenever you need me.', first ? ', ' + first : '') };
  if (/\bhow are you\b|\bhow\'s it going\b|\bwie geht/.test(low)) return { text: tr('I am doing great, thanks for asking! Ready when you are. What would you like to do?'), follow: WELCOME_FOLLOW };
  if (/\b(who|what) are you\b|\byour name\b|\bwho made you\b|\bwho built you\b/.test(low)) return { text: tr('I am the **MS LDS Assistant**, built into this application. I know the MS LDS user manual, your documents and your workflow tasks. I run entirely inside your system, so nothing you type is sent to an outside AI service.'), follow: [tr('What can you do?'), tr('Give me an overview')] };
  if (/\b(tell me a joke|joke)\b/.test(low)) return { text: tr('Why did the document go to the doctor? It was feeling **expired**. 😄 Shall we find some?'), follow: [tr('Expired documents')] };
  if (/^(help|\?|what can you do|menu|commands?|capabilities)\s*\??$/.test(low) || /\bwhat can you (do|help)\b/.test(low)) {
    ctx.topic = undefined;
    return { text: tr('**Here is what I can do**\n- **Find documents**: “published documents by martin”, “drafts created by me”, “expired documents”, “document 1234”, or a name in quotes.\n- **Search inside your documents** (full text) and **the user manual**: “which documents mention release?”, “search tags in the manual”, “find the text quality policy”.\n- **Your work**: “my pending tasks”, “give me an overview”.\n- **Explain MS LDS**: “how do I release a document?”, “what does Verified mean?”, “how to create a workflow?”, “what is a catchword?”.\n- **Guide you**: say “walk me through it” and I go step by step.\n- **Take you places**: “open workflow management”, “where are the tags?”.\n\nYou can also write casually, typos are fine.'), follow: [tr('Show my pending tasks'), tr('Walk me through adding a document'), tr('Give me an overview')] };
  }

  // ---- explicit topic pick from a clarification ----
  const ex = original.match(/^explain:\s*(.+)$/i);
  if (ex) { const e = KB.find(k => k.title.toLowerCase() === ex[1]!.trim().toLowerCase()); if (e) return answer(e, ctx); }

  // ---- follow-ups that depend on the last topic ----
  const cur = byId(ctx.topic);
  if (/^(tell me more|more|more details|details|go deeper|elaborate|why|why is that|and\??|what else|anything else)\b/.test(low) && cur) {
    if (cur.detail) { ctx.topic = cur.id; return { text: cur.detail, actions: cur.go ? [cur.go] : undefined, follow: (cur.more ?? []).slice(0, 3) }; }
    if (cur.more?.length) return { text: tr('There is more about **{0}**. You might also like:', cur.title), follow: cur.more };
    return { text: tr('That is all I have on **{0}**. Anything related you want to know?', cur.title), follow: WELCOME_FOLLOW };
  }
  if (/^(next|what('s| is)? next|what comes next|and then|what then|after that|then what)\b/.test(low) && cur) {
    const i = CHAIN.indexOf(cur.id);
    if (i >= 0 && i < CHAIN.length - 1) return answer(byId(CHAIN[i + 1])!, ctx, true);
    return { text: tr('**{0}** is the last step of the usual flow: Add → Edit → Verify → Release → Publish. After publishing the document stays on the web until it expires, then it is edited again.', cur.title), follow: [tr('What happens when a document expires?')] };
  }
  if (/^(previous|before that|what comes before|what before)\b/.test(low) && cur) {
    const i = CHAIN.indexOf(cur.id);
    if (i > 0) return answer(byId(CHAIN[i - 1])!, ctx, true);
  }
  if (/\b(walk me through|step by step|guide me|show me the steps|one by one|lead me)\b/.test(low) || /^walk me through it\b/.test(low)) {
    const t = lookup(fixTypos(low), 1)[0]?.e; const e = (t && /adding|add|release|publish|verify|workflow|rename|edit|assign/.test(low) ? t : null) ?? cur ?? t;
    if (e) { if (stepsOf(e).length >= 2) return { ...guideStep(e, 0, ctx), text: tr('Let us do **{0}** together. I will give you one step at a time, say **next** when you are ready.\n\n**Step 1 of {1}**\n{2}', e.title, stepsOf(e).length, stepsOf(e)[0]) }; return answer(e, ctx); }
  }

  // ---- index administration ----
  if (/\b(re-?index|rebuild)\b.*\b(search|index|documents?|content|knowledge)\b|^re-?index\b/.test(low)) {
    try { const full = /\b(rebuild|full|everything|all)\b/.test(low); await api.reindex(full); return { text: full ? tr('Started a **full rebuild** of the search index. It runs in the background; large archives can take a while.') : tr('Started an **index update**: only new or changed files are read.'), follow: [tr('How many documents are indexed?')] }; }
    catch (e) { return { text: (e as Error).message }; }
  }
  if (/\b(index|search) (status|state)\b|\bhow many documents (are |were )?(indexed|searchable)\b|\bis (the )?(search|index) (ready|up to date|working)\b/.test(low)) {
    const st = await api.searchStatus();
    return { text: tr('**Search index**\n- Documents indexed: **{0}**\n- {1}\n- Last scan: {2} new or changed, {3} skipped (no file or unsupported type), {4} could not be read{5}{6}', st.documents, st.running ? tr('Scanning now, {0} left to check', st.pending) : st.lastEnd ? tr('Last scan finished {0}', new Date(st.lastEnd).toLocaleString()) : tr('No scan has finished yet'), st.indexed, st.skipped, st.failed, st.note ? tr('\n- Note: {0}', st.note) : '', st.problems?.length ? tr('\n\n**Problems found**\n{0}', st.problems.map(x => '- ' + x).join('\n')) : ''), follow: [tr('Rebuild the search index')] };
  }
  // ---- search inside documents / the manual ----
  const ct = contentTerm(original);
  if (ct && ct.term.length >= 2) {
    const r = await knowledge(ct.term, env, ct.scope, ctx);
    if (r) return r;
    return { text: tr('I found nothing for “{0}” {1}.{2} Try another word or fewer words.', ct.term, ct.scope === 'manual' ? tr('in the manual') : ct.scope === 'docs' ? tr('inside your documents') : tr('in your documents or the manual'), ct.scope !== 'manual' ? await emptyIndexNote() : ''), follow: [tr('Help')] };
  }

  // ---- my tasks ----
  if (/\b(my|pending|open|assigned|waiting)\b.*\b(tasks?|workflow|to ?do)\b|\bwhat (do|should) i (have|need) to do\b|\btasks? (for me|waiting)\b|\bdo i have (any )?tasks?\b/.test(low) && !/\bhow\b/.test(low)) {
    const r = await api.wfSummary();
    if (!r.enabled) return { text: tr('Workflow is not enabled on this system, so there are no tasks.') };
    return {
      text: r.total === 0 ? tr('You have no open workflow tasks. Nothing is waiting for you. 🎉') : tr('You have **{0}** open task{1}{2}. The newest:', r.total, r.total === 1 ? '' : 's', r.overdue ? `, **${r.overdue}** of them overdue` : ''),
      tasks: r.items.slice(0, 5), actions: r.total ? [{ label: tr('Open My tasks'), to: '/tasks' }] : undefined, follow: r.total ? [tr('Give me an overview')] : undefined,
    };
  }
  // ---- overview ----
  if (/\b(overview|summary|statistics|stats|kpi|dashboard numbers|how is the system|status report|numbers)\b/.test(low) && !/\bhow (do|to|can)\b/.test(low)) {
    const r: Stats = await api.stats(env.lang); const k = r.kpi;
    return {
      text: tr('Here is the picture for **{0}**: **{1}** documents, **{2}** published{3}{4}.', env.lang, k.total, k.published, k.expired ? `, **${k.expired}** expired` : '', k.expiringSoon ? `, **${k.expiringSoon}** expiring soon` : ''),
      tiles: [
        { label: tr('Total'), value: k.total, tone: 'b', to: '/documents' }, { label: tr('Published'), value: k.published, tone: 'g', to: '/documents' }, { label: tr('Draft'), value: k.draft, tone: 'n', to: '/documents' },
        { label: tr('In edit'), value: k.edit, tone: 'o', to: '/documents' }, { label: tr('Verified'), value: k.verified, tone: 'p', to: '/documents' }, { label: tr('Released'), value: k.released, tone: 't', to: '/documents' },
        { label: tr('Expired'), value: k.expired, tone: 'r', to: '/documents' }, { label: tr('Expiring soon'), value: k.expiringSoon, tone: 'y', to: '/documents' }],
      actions: [{ label: tr('Open Analytics'), to: '/analytics' }], follow: k.expired ? [tr('Expired documents')] : [tr('Show my pending tasks')],
    };
  }
  // ---- navigation / where is ----
  const navM = low.match(/^(?:please |can you |could you )?(?:open|go to|goto|take me to|show me the|navigate to|launch|bring me to)\s+(?:the\s+)?(.+)$/);
  if (navM) { const hit = NAV.find(([re]) => re.test(navM[1]!)); if (hit) return { text: tr('Opening **{0}**…', hit[2]), actions: [{ label: tr('Open {0}', hit[2]), to: hit[1] }], navigate: hit[1] }; }
  const whereM = /\b(where|which menu|which page|how do i (get|find|reach))\b/.test(low) ? NAV.find(([re]) => re.test(low.replace(/\bwhere\b/g, ''))) : undefined;
  if (whereM && !/\b(release|publish|verify|rename)\b/.test(low)) return { text: tr('You find **{0}** under {1}.', whereM[2], whereM[3]), actions: [{ label: tr('Open {0}', whereM[2]), to: whereM[1] }] };

  // ---- document search vs. how-to ----
  for (const [re, to] of SYN) low = low.replace(re, to);
  const fixed = fixTypos(low);
  const p = parsePrompt(fixed === low ? original : fixed, env.short);
  const kb = lookup(fixed, 3);
  const top = kb[0], second = kb[1];
  const strong = !!top && top.score >= 3;
  const searchy = p.chips.length > 0 && (p.idOnly !== undefined || p.q.status !== undefined || !!p.q.publisher || !!p.q.releaser || !!p.q.creator || !!p.q.expired || /["“']/.test(original) || !isQuestion(fixed));
  if (strong && (isQuestion(fixed) || !searchy)) {
    if (second && second.score >= 3 && second.score > top!.score * 0.8 && second.e.id !== top!.e.id && !isQuestion(fixed)) {
      return { text: tr('Your question fits more than one topic. Which one do you mean?'), follow: [top!.e, second.e].map(x => tr('Explain: {0}', x.title)) };
    }
    const rep = answer(top!.e, ctx, isQuestion(fixed));
    const mh = await searchManual(fixed, 1);
    if (mh[0] && confident(mh[0])) rep.manual = mh;
    return rep;
  }
  if (searchy) {
    ctx.topic = undefined;
    const res = await api.documents({ ...p.q, lang: env.lang, pageSize: p.countOnly ? 1 : 8, withPaths: !p.countOnly });
    return {
      chips: p.chips, total: res.total, query: p.q, docs: p.countOnly ? [] : res.items,
      text: res.total === 0 ? tr('I found no documents for that (within the folders you may access). Try fewer words or a different status.')
        : p.countOnly ? tr('**{0}** document{1} match.', res.total, res.total === 1 ? '' : 's')
        : tr('I found **{0}** document{1}{2}.', res.total, res.total === 1 ? '' : 's', res.total > res.items.length ? tr(', here are the latest {0}', res.items.length) : ''),
      follow: res.total === 0 ? [tr('Expired documents'), tr('Show published documents')] : [tr('Give me an overview'), tr('Show my pending tasks')],
    };
  }
  const kn = await knowledge(fixed, env, 'both', ctx, tr('I could not match that to a ready answer, but I searched the knowledge I have:'));
  if (kn) return kn;
  if (top) return answer(top.e, ctx, true);
  return { text: tr('I am not sure I understood{0}. I can search documents (“published by martin”), explain a function (“how do I release a document?”) or open a page (“open tags”). Try one of these:', first ? ', ' + first : ''), follow: [tr('Help'), tr('Show my pending tasks'), tr('How does a workflow work?')] };
}
