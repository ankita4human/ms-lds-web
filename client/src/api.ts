const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '';
const KEY = 'pl_token';
export const auth = {
  get: () => sessionStorage.getItem(KEY),
  set: (t: string) => { sessionStorage.setItem(KEY, t); window.dispatchEvent(new Event('pl-auth')); },
  clear: () => { sessionStorage.removeItem(KEY); window.dispatchEvent(new Event('pl-auth')); },
};
async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const t = auth.get();
  if (t) headers.set('Authorization', `Bearer ${t}`);
  const r = await fetch(`${BASE}${path}`, { ...init, headers });
  if (r.status === 401 && path !== '/api/lds/login') { auth.clear(); location.assign('/login'); }
  if (!r.ok) {
    let msg = r.status === 401 ? 'Invalid login or password' : `Request failed (${r.status})`;
    try { const j = await r.json(); if (j?.error) msg = j.error; } catch { /* no body */ }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

export type DocRow = {
  idDoc: number; docName: string; lang: string; langStandard?: string;
  status: number; statusName: string; type: number; typeName: string;
  v1: number; v2: number; v3: number; extension?: string;
  dateCre?: string; dateMod?: string; dateExp?: string; datePub?: string; dateRel?: string; doNotExpire?: boolean; isCycle?: boolean; doNotPublish?: boolean;
  creator?: string; publisher?: string; releaser?: string; paths?: string[];
};
export type DocPage = { total: number; page: number; pageSize: number; items: DocRow[] };
export type GroupNode = { idGroup: number; idParent: number; name: string; sort: number; groupType?: number; docCount: number; accessible: boolean;
  hasChildren?: boolean; doNotPublish?: boolean; pubOriginal?: boolean; idProcessOwner?: number; processOwner?: string };
export type GroupTree = { groups: GroupNode[]; total: number; expired: number; templateGroup?: number; canCreateRoot?: boolean };
export type GroupOrderData = { groups: { id: number; name: string; canMove: boolean }[]; docs: { id: number; name: string; status: number }[] };
export type GroupReport = { title: string; lang: string; generated: string; documents: number;
  sections: { idGroup: number; name: string; path: string; docs: { idDoc: number; name: string; type?: string; version?: string; author?: string; created?: string; editor?: string; modified?: string; publisher?: string; published?: string }[] }[] };
export type HistoryRow = { v1?: number; v2?: number; v3?: number; user?: string; modDate?: string; modDesc?: string };
export type DocDetail = { doc: DocRow; notes?: string; processOwner?: string; paths: string[]; groupIds?: number[]; history: HistoryRow[] };
export type Me = { idAcc: number; accShort: string; name?: string; isAdmin: boolean; rights: number[]; lastLogin?: string };
export type Lang = { lang: string; name?: string };
export type Stat = { label: string; count: number };
export type Stats = {
  kpi: { total: number; published: number; draft: number; edit: number; verified: number; released: number; expired: number; expiringSoon: number };
  byStatus: Stat[]; byType: Stat[]; byAuthor: Stat[]; byPublisher: Stat[]; byReleaser: Stat[];
  byExtension: Stat[]; byLanguage: Stat[]; createdByYear: Stat[]; publishedByYear: Stat[]; expiry: Stat[]; expiringDocs: DocRow[];
};
export type DocQuery = {
  page: number; pageSize: number; text?: string; lang?: string; sort?: string; desc?: boolean;
  groupId?: number; direct?: boolean; expired?: boolean; status?: number; creator?: string; publisher?: string; releaser?: string; withPaths?: boolean; filterId?: number;
};

export type DocTypeOpt = { idType: number; name?: string };
export type UploadResult = { idDoc: number; lang: string; languages: string[]; name: string; version?: string; folders: string[] };
export type VersionResult = { idDoc: number; lang: string; version: string; languages: string[]; republish?: boolean };
export type CheckInResult = { idDoc: number; lang: string; version: string; status: number; languages: string[]; archived: boolean };

/** Upload with progress (fetch cannot report upload progress). */
export function uploadDocument(form: FormData, onProgress: (pct: number) => void): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', `${BASE}/api/lds/documents/upload`);
    const t = auth.get(); if (t) x.setRequestHeader('Authorization', `Bearer ${t}`);
    x.upload.onprogress = e => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    x.onerror = () => reject(new Error('Network error: the API is not reachable.'));
    x.onload = () => {
      let body: { error?: string } & Partial<UploadResult> = {};
      try { body = JSON.parse(x.responseText); } catch { /* no body */ }
      if (x.status === 401) { auth.clear(); location.assign('/login'); }
      if (x.status >= 200 && x.status < 300) resolve(body as UploadResult);
      else reject(new Error(body.error ?? `Upload failed (${x.status})`));
    };
    x.send(form);
  });
}

export async function downloadDocFile(id: number, lang: string, fallbackName?: string): Promise<void> {
  const t = auth.get();
  const r = await fetch(`${BASE}/api/lds/documents/${id}/file?lang=${encodeURIComponent(lang)}`, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
  if (!r.ok) { let m = `Download failed (${r.status})`; try { const j = await r.json(); if (j?.error) m = j.error; } catch { /* no body */ } throw new Error(m); }
  const cd = r.headers.get('Content-Disposition') ?? '';
  const name = r.headers.get('X-File-Name') ?? /filename\*=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd)?.[1] ?? /filename="?([^";]+)"?/i.exec(cd)?.[1] ?? fallbackName ?? `D${id}_${lang}`;
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement('a'); a.href = url; a.download = (() => { try { return decodeURIComponent(name); } catch { return name; } })(); document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export type DateRange = { active: boolean; from: string; to: string };
export type FilterCriteria = {
  docName?: string; docId?: string; statuses?: number[]; types?: number[]; searchText?: string; special?: number;
  author?: number; editor?: number; verifier?: number; releaser?: number; publisher?: number; distributor?: number; processOwner?: number;
  application?: string; language?: string; group?: number; includeSubgroups?: boolean; unlinked?: boolean; groupNumber?: string;
  created?: DateRange; edited?: DateRange; released?: DateRange; published?: DateRange; expired?: DateRange;
};
export type FilterHead = { idFilter: number; name: string; general: boolean; web: boolean; mine: boolean };
export type IdName = { id: number; name: string };
export type FilterOptions = {
  statuses: IdName[]; types: IdName[]; accounts: IdName[]; owners: IdName[]; mailLists: IdName[]; extensions: string[];
  languages: { id: string; name: string }[]; groups: { id: number; parent: number; name: string }[]; specials: IdName[];
};
export type FilterBody = { name: string; general: boolean; web: boolean; criteria: FilterCriteria; lang?: string };

export type TypeItem = { idType: number; name: string; shortForm: string; life: number; isTemplate: boolean; publishAsOriginal: boolean; is14DaysRelease: boolean; untranslated: boolean; documents: number; isDefault: boolean };
export type TypeBody = { lang: string; name: string; shortForm: string; life: number; isTemplate: boolean; publishAsOriginal: boolean; is14DaysRelease: boolean };

export type UserHead = { idAcc: number; name: string; login: string; email: string; active: boolean; ntAuth: boolean; processOwner: boolean; changePwd: boolean; lastLogin?: string | null; isSync: boolean };
export type UserBody = { name: string; login: string; email: string; active: boolean; ntAuth: boolean; processOwner: boolean };
export type RightItem = { id: number; rcod: number; rvalue: string; name: string; groupId: number };
export type IdLabel = { id: number; name: string };
export type RightsCatalog = { rights: IdLabel[]; groups: { id: number; parent: number; name: string }[]; singleGroupCode: number };
const j = (b: unknown) => JSON.stringify(b);

export type MailMember = { idec: number; name: string; email: string; isAccount: boolean };
export type MailListItem = { id: number; name: string; members: number; documents: number };
export type MailListDetail = { id: number; name: string; members: MailMember[]; usage: { documents: number; audits: number; matrix: number; other: number } };
export type DocDistribution = { canManage: boolean; lists: { id: number; name: string; members: MailMember[] }[]; available: { id: number; name: string }[] };

export type PubJob = { id: string; idDoc: number; lang: string; docName: string; version: string; kind: 'publish' | 'relpub'; status: 'queued' | 'running' | 'done' | 'failed';
  position: number; queuedAt: string; finishedAt?: string | null; error?: string | null; warnings?: string[]; files: number; tagsReplaced: number; mailStatus?: string | null; mailError?: string | null };
export type PubFeedItem = { idDoc: number; lang: string; docName: string; ext: string; version: string; publishedOn: string; publishedById?: number; publishedBy: string; type?: string };
export type MailRecip = { email: string; name?: string | null; src?: string };
export type MailOptions = { enabled: boolean; release: boolean; publish: boolean; smtpOk: boolean; from: string; quietUntil?: string | null };
export type MailDraft = { stage: 'release' | 'publish' | 'frozen'; lang: string; enabled: boolean; smtpOk: boolean; from: string; sendDefault: boolean; to: MailRecip[]; cc: MailRecip[];
  subject: string; header: string; footer: string; html: string; classicHtml: string; hasTemplate: boolean; quietUntil?: string | null; saved: boolean };
export type MailPayload = { send: boolean; to: string[]; cc: string[]; subject: string; html: string; header: string; footer: string };
export type Notifications = { total: number; days: number; items: PubFeedItem[]; jobs: PubJob[]; me: number };
export type FlowResult = { idDoc: number; lang: string; status: number; version: string; verifiedOn?: string; releasedOn?: string; expires?: string | null; languages?: string[]; publishedOn?: string; folder?: string; files?: string[]; warnings?: string[]; tagsReplaced?: number; queued?: boolean; jobId?: string; position?: number; mailSent?: boolean; mailError?: string | null; publishMail?: boolean };


export type StdNode = { id: number; parent: number; name: string; untranslated: boolean; chapterNo: string; shortName: string; inActive: boolean; mandatory: boolean; documents: number; association: number };
export type StdTree = { items: StdNode[]; rootName: string; canManage: boolean };
export type StdDetail = { id: number; parent: number; name: string; chapterNo: string; shortName: string; description: string; inActive: boolean; mandatory: boolean; association: number };
export type StdBody = { lang: string; parentId?: number; name: string; shortName?: string; chapterNo?: string; description?: string; inActive?: boolean };
export type StdXlsxInfo = { name: string; chapters: number; languages: string[]; ignored: string[]; missing: string[]; duplicate: boolean; shortName: string };
export type StdAssoc = { id: number; name: string; chapters: number };
export type DocStd = { items: { id: number; name: string; linked: boolean }[]; notifyAdmin: boolean };
export type DepItem = { id: number; name: string; documents: number };
export type DepDocItem = { idDoc: number; name: string; status: number; statusName: string; version: string };
export type DependentItem = DepDocItem & { lang: string; dependency: string; movable: boolean };

// ---- Workflow (Options > Workflow management, document workflow, My tasks) ----
export type WfConfig = { enabled: boolean; canManage: boolean; canUse: boolean };
export type WfHead = { id: number; name: string; active: boolean; steps: number; documents: number };
export type WfName = { id: number; name: string };
export type WfOptions = { docTypes: WfName[]; userGroups: WfName[]; users: WfName[]; groups: WfName[]; layers: WfName[] };
export type WfStepBody = { id: number; name: string; layer: number; editor: number; userGroup: number; days: number; description: string; inUse?: boolean };
export type WfDetail = { id: number; name: string; active: boolean; description: string; docTypes: number[]; userGroups: number[]; groups: number[]; steps: WfStepBody[] };
export type WfSaveBody = { name: string; active: boolean; description: string; docTypes: number[]; userGroups: number[]; groups: number[]; steps: WfStepBody[] };
export type WfStep = { id: number; name: string; layer: number; layerName: string; days: number; description: string; editor: number; candidates: WfName[] };
export type WfDocInfo = { id: number; name: string; status: number; version: string; type?: number };
export type WfCycle = { id: number; name: string; description: string; startStep: number; nextDefault: number; steps: WfStep[]; docTypes: number[]; userGroups: number[]; groups: number[] };
export type WfFilters = { docTypes: WfName[]; userGroups: WfName[]; groups: WfName[] };
export type WfCurrent = {
  taskId: number; moveId: number; step: string; layer: number; layerName: string; stepDescription: string; assigneeId: number; assignee: string;
  startedById: number; startedBy: string; dateStart?: string; due?: string; remark: string; overdue: boolean; expectedStatus: number; isLast: boolean;
};
export type WfHistoryItem = { taskId: number; step: string; layerName: string; assignee: string; assignedBy: string; assigned?: string; due?: string; finished?: string; outcome: 'open' | 'done' | 'returned'; remark: string };
export type WfState =
  | { inWorkflow: false; doc: WfDocInfo; canStart: boolean; filters: WfFilters; cycles: WfCycle[] }
  | { inWorkflow: true; doc: WfDocInfo; cycle: { id: number; name: string; description: string }; current: WfCurrent | null; canAct: boolean; canRemove: boolean;
      next: { nextDefault: number; finish: boolean }; previous: { moveId: number; editorId: number; editor: string; step: string } | null; steps: WfStep[];
      history: { run: number; items: WfHistoryItem[] } };
export type WfRun = { run: number; current: boolean; workflow: string; data: { run: number; items: WfHistoryItem[] } };
export type WfTaskItem = { taskId: number; idDoc: number; lang: string; docName: string; ext?: string; status: number; statusName: string; version: string; workflow: string; step: string;
  layer: number; layerName: string; startedBy: string; assigned?: string; due?: string; overdue: boolean; remark: string };
export type WfTaskNote = { taskId: number; idDoc: number; lang: string; docName: string; workflow: string; step: string; layer: number; layerName: string; startedBy: string; assigned?: string; due?: string; overdue: boolean };
export type ContentItem = { idDoc: number; lang: string; docName: string; ext: string; status: number; statusName: string; version: string; folder?: string | null; snippet: string; score: number };
export type ContentSearch = { items: ContentItem[]; indexed: number; running: boolean };
export type IndexStatus = { documents: number; pending: number; running: boolean; lastStart?: string; lastEnd?: string; indexed: number; skipped: number; failed: number; note?: string };
export type WfSummary = { enabled: boolean; total: number; overdue: number; counts: number[]; items: WfTaskNote[] };
export type WfTasks = { enabled: boolean; counts: number[]; layerNames?: string[]; items: WfTaskItem[] };
export type WfHandOver = { lang: string; nextMoveId: number; editorId: number; due?: string | null; remark?: string };

// ---- Document tabs (Control, Catch, Linking, Dependency) and Catch Management ----
export type CtlEntry = { on?: string; by: string };
export type DocControl = { created: CtlEntry; released: CtlEntry; edited: CtlEntry; verified: CtlEntry; published: CtlEntry };
export type DocCatchItem = { idCatch: number; word: string; active: boolean; manual: boolean };
export type DocCatchData = { enabled: boolean; canManage: boolean; docLevel: boolean; minLen: number; items: DocCatchItem[] };
export type DocLinks = {
  outgoing: { link: string; targetId: number; name: string; accessible: boolean; kind: 'document' | 'external' | 'mail' }[];
  incoming: { sourceId: number; name: string; accessible: boolean }[];
};
export type DocDeps = { canManage: boolean; items: { id: number; name: string; documents: { idDoc: number; name: string; status: number; self: boolean }[] }[]; available: { id: number; name: string }[] };
export type CatchConfig = { enabled: boolean; canManage: boolean; docLevel: boolean; minLen: number };
export type CatchWord = { id: number; word: string; active: boolean; documents: number };
export type CatchPage = { total: number; page: number; pageSize: number; all: number; active: number; items: CatchWord[] };
export type CatchDoc = { idDoc: number; name: string; status: number; manual: boolean; active: boolean };

export type TagItem = { id: number; name: string; description?: string; value?: string | null; app: number };
export type TagList = { kind: string; lang: string; otherEnabled: boolean; products: { id: number; name: string }[]; items: TagItem[] };
export type AppTag = { id: number; tag: string; description: string; replacement: string };
export type AppTagList = { lang: string; maxDescription: number; maxReplacement: number; items: AppTag[] };
export type AppTagHist = { sNo: number; tag: number; name: string; replacement: string; created?: string; createdBy?: string; modified?: string; modifiedBy?: string; current: boolean };
export type DeletedDoc = { id: number; name: string; version: string; status: number; type: string; deleted?: string; deletedBy?: string };
export type DeletedPage = { lang: string; page: number; pageSize: number; total: number; items: DeletedDoc[] };
export type BrokenLink = { id: number; name: string; targetId: number; target: string; error: string };
export type WebHit = { id: number; name: string; hits: number; last?: string };
export type WebHistory = { lang: string; from: string; to: string; page: number; pageSize: number; total: number; hits: number; items: WebHit[] };
export type AppCatchWord = { id: number; word: string; active: boolean };

/** Photo of a user as an object URL, or null when the user has none (204). */
async function fetchPhoto(id: number): Promise<string | null> {
  const t = auth.get();
  const r = await fetch(`${BASE}/api/lds/users/${id}/photo`, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
  if (r.status === 204 || r.status === 404) return null;
  if (!r.ok) throw new Error(`Photo request failed (${r.status})`);
  return URL.createObjectURL(await r.blob());
}

export const api = {
  photo: fetchPhoto,
  uploadPhoto: (blob: Blob) => { const f = new FormData(); f.append('file', blob, 'photo.jpg'); return req<{ saved: boolean }>('/api/lds/me/photo', { method: 'PUT', body: f }); },
  deletePhoto: () => req<{ removed: boolean }>('/api/lds/me/photo', { method: 'DELETE' }),
  // ---- Options > Tags and Program options > Admin ----
  tags: (lang: string, kind: string, app = 0) => req<TagList>(`/api/lds/tags?lang=${encodeURIComponent(lang)}&kind=${kind}&app=${app}`),
  appTags: (lang: string) => req<AppTagList>(`/api/lds/admin/app-tags?lang=${encodeURIComponent(lang)}`),
  addAppTag: (lang: string, description: string, replacement: string) => req<{ id: number }>('/api/lds/admin/app-tags', { method: 'POST', body: JSON.stringify({ lang, description, replacement }) }),
  editAppTag: (id: number, lang: string, description: string, replacement: string) => req<{ changed: boolean }>(`/api/lds/admin/app-tags/${id}`, { method: 'PUT', body: JSON.stringify({ lang, description, replacement }) }),
  deleteAppTag: (id: number, lang: string) => req<{ removed: number }>(`/api/lds/admin/app-tags/${id}?lang=${encodeURIComponent(lang)}`, { method: 'DELETE' }),
  appTagHistory: (lang: string) => req<AppTagHist[]>(`/api/lds/admin/app-tags/history?lang=${encodeURIComponent(lang)}`),
  deletedDocs: (lang: string, q: string, page: number) => req<DeletedPage>(`/api/lds/admin/deleted-docs?lang=${encodeURIComponent(lang)}&q=${encodeURIComponent(q)}&page=${page}`),
  brokenLinks: (lang: string, type: string) => req<{ items: BrokenLink[] }>(`/api/lds/admin/broken-links?lang=${encodeURIComponent(lang)}&type=${type}`),
  webHistory: (lang: string, from: string, to: string, page: number) => req<WebHistory>(`/api/lds/admin/web-history?lang=${encodeURIComponent(lang)}&from=${from}&to=${to}&page=${page}`),
  deleteWebHistory: (from: string, to: string) => req<{ removed: number }>('/api/lds/admin/web-history/delete', { method: 'POST', body: JSON.stringify({ from, to }) }),
  appCatch: (lang: string) => req<{ items: AppCatchWord[] }>(`/api/lds/admin/app-catch?lang=${encodeURIComponent(lang)}`),
  addAppCatch: (lang: string, words: string[]) => req<{ added: number; existing: number }>('/api/lds/admin/app-catch', { method: 'POST', body: JSON.stringify({ lang, words }) }),
  setAppCatchState: (lang: string, ids: number[], active: boolean) => req<{ changed: number }>('/api/lds/admin/app-catch/state', { method: 'PUT', body: JSON.stringify({ lang, ids, active }) }),
  deleteAppCatch: (ids: number[]) => req<{ removed: number }>('/api/lds/admin/app-catch/delete', { method: 'POST', body: JSON.stringify({ ids }) }),
  // ---- Options > Standard management ----
  standards: (lang: string) => req<StdTree>(`/api/lds/standards?lang=${encodeURIComponent(lang)}`),
  standard: (id: number, lang: string) => req<StdDetail>(`/api/lds/standards/${id}?lang=${encodeURIComponent(lang)}`),
  createStandard: (b: StdBody) => req<{ id: number }>('/api/lds/standards', { method: 'POST', body: JSON.stringify(b) }),
  updateStandard: (id: number, b: StdBody) => req<{ id: number }>(`/api/lds/standards/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
  removeStandard: (id: number) => req<{ removed: number }>(`/api/lds/standards/${id}`, { method: 'DELETE' }),
  standardOptions: () => req<{ enabled: boolean }>('/api/lds/standards/options'),
  setMandatoryRoots: (ids: number[]) => req<{ mandatory: number }>('/api/lds/standards/mandatory', { method: 'PUT', body: JSON.stringify({ ids }) }),
  setMandatory: (id: number, value: boolean) => req<{ mandatory: boolean }>(`/api/lds/standards/${id}/mandatory`, { method: 'PUT', body: JSON.stringify({ value }) }),
  importStandard: (b: { lang: string; name: string; shortName?: string; description?: string; rows: { chapterNo: string; name: string; description: string }[] }) =>
    req<{ id: number; chapters: number }>('/api/lds/standards/import', { method: 'POST', body: JSON.stringify(b) }),
  importStandardXlsx: (file: File, commit: boolean, lang: string) => { const f = new FormData(); f.append('file', file); f.append('commit', String(commit)); f.append('lang', lang);
    return req<StdXlsxInfo & { id?: number }>('/api/lds/standards/import-xlsx', { method: 'POST', body: f }); },
  stdAssociations: () => req<StdAssoc[]>('/api/lds/standards/associations'),
  createStdAssociation: (name: string) => req<{ id: number }>('/api/lds/standards/associations', { method: 'POST', body: JSON.stringify({ name }) }),
  renameStdAssociation: (id: number, name: string) => req<{ id: number }>(`/api/lds/standards/associations/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }),
  deleteStdAssociation: (id: number) => req<{ id: number }>(`/api/lds/standards/associations/${id}`, { method: 'DELETE' }),
  linkStdAssociation: (id: number, idAssociation: number) => req<{ id: number }>(`/api/lds/standards/${id}/association`, { method: 'PUT', body: JSON.stringify({ idAssociation }) }),
  docStandards: (id: number, lang: string) => req<DocStd>(`/api/lds/documents/${id}/standards?lang=${encodeURIComponent(lang)}`),
  setDocStandards: (id: number, lang: string, ids: number[]) => req<{ id: number }>(`/api/lds/documents/${id}/standards?lang=${encodeURIComponent(lang)}`, { method: 'PUT', body: JSON.stringify({ ids }) }),
  // ---- Options > Dependency ----
  dependencies: (lang: string) => req<{ items: DepItem[]; canManage: boolean; editChoice: boolean }>(`/api/lds/dependencies?lang=${encodeURIComponent(lang)}`),
  createDependency: (lang: string, name: string) => req<{ id: number }>('/api/lds/dependencies', { method: 'POST', body: JSON.stringify({ lang, name }) }),
  renameDependency: (id: number, name: string) => req<{ id: number }>(`/api/lds/dependencies/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }),
  deleteDependency: (id: number) => req<{ id: number }>(`/api/lds/dependencies/${id}`, { method: 'DELETE' }),
  dependencyDocs: (id: number) => req<{ lang: string; items: DepDocItem[] }>(`/api/lds/dependencies/${id}/documents`),
  dependencyCandidates: (lang: string, q: string, groupId?: number | null) => req<DepDocItem[]>(`/api/lds/dependencies/candidates?lang=${encodeURIComponent(lang)}&q=${encodeURIComponent(q)}${groupId ? `&groupId=${groupId}` : ''}`),
  addDependencyDocs: (id: number, ids: number[]) => req<{ added: number; skipped: number }>(`/api/lds/dependencies/${id}/documents`, { method: 'POST', body: JSON.stringify({ ids }) }),
  removeDependencyDoc: (id: number, idDoc: number) => req<{ id: number }>(`/api/lds/dependencies/${id}/documents/${idDoc}`, { method: 'DELETE' }),
  dependents: (id: number, lang: string) => req<{ choose: boolean; items: DependentItem[] }>(`/api/lds/documents/${id}/dependents?lang=${encodeURIComponent(lang)}`),
  editDependents: (id: number, lang: string, ids: number[]) => req<{ moved: number; documents: number[] }>(`/api/lds/documents/${id}/dependents/edit`, { method: 'POST', body: JSON.stringify({ lang, ids }) }),
  // ---- Frozen / Defrozen, expiry ----
  setFrozenOptions: (enabled: boolean, doNotExpire: boolean) => req<{ enabled: boolean; doNotExpire: boolean }>('/api/lds/frozen/options', { method: 'PUT', body: JSON.stringify({ enabled, doNotExpire }) }),
  frozenOptions: () => req<{ enabled: boolean; canManage: boolean; doNotExpire: boolean }>('/api/lds/frozen/options'),
  freezeDoc: (id: number, lang: string, expires?: string | null, mail?: MailPayload) => req<FlowResult & { mailSent?: boolean; mailError?: string | null }>(`/api/lds/documents/${id}/freeze`, { method: 'POST', body: JSON.stringify({ lang, expires, mail }) }),
  defreezeDoc: (id: number, lang: string, expires?: string | null) => req<FlowResult>(`/api/lds/documents/${id}/defreeze`, { method: 'POST', body: JSON.stringify({ lang, expires }) }),
  setExpiry: (id: number, lang: string, dateExp?: string | null, doNotExpire?: boolean) => req<{ dateExp: string | null; doNotExpire: boolean; languages: string }>(`/api/lds/documents/${id}/expiry`, { method: 'PUT', body: JSON.stringify({ lang, dateExp, doNotExpire }) }),
  // ---- Document tabs, Catch Management ----
  docControl: (id: number, lang: string) => req<DocControl>(`/api/lds/documents/${id}/control?lang=${encodeURIComponent(lang)}`),
  docCatch: (id: number, lang: string) => req<DocCatchData>(`/api/lds/documents/${id}/catch?lang=${encodeURIComponent(lang)}`),
  addDocCatch: (id: number, lang: string, words: string[]) => req<{ created: number; linked: number; message: string }>(`/api/lds/documents/${id}/catch`, { method: 'POST', body: JSON.stringify({ lang, words }) }),
  setDocCatchState: (id: number, lang: string, ids: number[], active: boolean) => req<{ changed: number }>(`/api/lds/documents/${id}/catch/state`, { method: 'PUT', body: JSON.stringify({ lang, ids, active }) }),
  docLinks: (id: number, lang: string) => req<DocLinks>(`/api/lds/documents/${id}/links?lang=${encodeURIComponent(lang)}`),
  docDependencies: (id: number, lang: string) => req<DocDeps>(`/api/lds/documents/${id}/dependencies?lang=${encodeURIComponent(lang)}`),
  catchConfig: () => req<CatchConfig>('/api/lds/catch/config'),
  catchWords: (lang: string, q: string, state: string, page: number) => req<CatchPage>(`/api/lds/catch?lang=${encodeURIComponent(lang)}&q=${encodeURIComponent(q)}&state=${state}&page=${page}&pageSize=100`),
  catchDocs: (id: number) => req<{ items: CatchDoc[] }>(`/api/lds/catch/${id}/documents`),
  setCatchState: (ids: number[], active: boolean) => req<{ changed: number }>('/api/lds/catch/state', { method: 'PUT', body: JSON.stringify({ ids, active }) }),
  setCatchDocState: (items: { idDoc: number; idCatch: number; active: boolean }[]) => req<{ changed: number }>('/api/lds/catch/documents/state', { method: 'PUT', body: JSON.stringify({ items }) }),
  editCatch: (id: number, word: string) => req<{ id: number }>(`/api/lds/catch/${id}`, { method: 'PUT', body: JSON.stringify({ word }) }),
  deleteCatch: (ids: number[]) => req<{ removed: number }>('/api/lds/catch/delete', { method: 'POST', body: JSON.stringify({ ids }) }),
  // ---- Workflow ----
  wfConfig: () => req<WfConfig>('/api/lds/workflow/config'),
  workflows: () => req<{ items: WfHead[] }>('/api/lds/workflows'),
  wfOptions: (lang: string) => req<WfOptions>(`/api/lds/workflows/options?lang=${encodeURIComponent(lang)}`),
  wf: (id: number) => req<WfDetail>(`/api/lds/workflows/${id}`),
  wfCreate: (b: WfSaveBody) => req<{ id: number }>('/api/lds/workflows', { method: 'POST', body: JSON.stringify(b) }),
  wfUpdate: (id: number, b: WfSaveBody) => req<{ id: number }>(`/api/lds/workflows/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
  wfDelete: (id: number) => req<{ removed: number }>(`/api/lds/workflows/${id}`, { method: 'DELETE' }),
  wfState: (docId: number, lang: string) => req<WfState>(`/api/lds/documents/${docId}/workflow?lang=${encodeURIComponent(lang)}`),
  wfStart: (docId: number, b: WfHandOver & { cycleId: number }) => req<{ started: boolean; mail: string }>(`/api/lds/documents/${docId}/workflow/start`, { method: 'POST', body: JSON.stringify(b) }),
  wfAdvance: (docId: number, b: WfHandOver & { taskId: number; action: 'accept' | 'reject' }) => req<{ finished: boolean; rejected: boolean; mail: string }>(`/api/lds/documents/${docId}/workflow/advance`, { method: 'POST', body: JSON.stringify(b) }),
  wfRemove: (docId: number, lang: string, reason: string) => req<{ removed: boolean }>(`/api/lds/documents/${docId}/workflow/remove`, { method: 'POST', body: JSON.stringify({ lang, reason }) }),
  wfHistory: (docId: number, lang: string) => req<{ runs: WfRun[] }>(`/api/lds/documents/${docId}/workflow/history?lang=${encodeURIComponent(lang)}`),
  wfMailTest: (lang: string) => req<{ ok: boolean; message: string }>('/api/lds/workflow/mail-test', { method: 'POST', body: JSON.stringify({ lang }) }),
  searchContent: (q: string, lang: string, limit = 8) => req<ContentSearch>(`/api/lds/search/content?q=${encodeURIComponent(q)}&lang=${encodeURIComponent(lang)}&limit=${limit}`),
  searchStatus: () => req<IndexStatus>('/api/lds/search/status'),
  reindex: (full: boolean) => req<{ started: boolean; full: boolean }>(`/api/lds/search/reindex?full=${full}`, { method: 'POST' }),
  wfSummary: () => req<WfSummary>('/api/lds/workflow/tasks/summary'),
  wfTasks: (lang: string, layer = 0) => req<WfTasks>(`/api/lds/workflow/tasks?lang=${encodeURIComponent(lang)}&layer=${layer}`),
  workflowOptions: () => req<{ validateOnRelease: boolean }>('/api/lds/workflow/options'),
  verifyDoc: (id: number, lang: string) => req<FlowResult>(`/api/lds/documents/${id}/verify?lang=${encodeURIComponent(lang)}`, { method: 'POST' }),
  notifications: (lang: string) => req<Notifications>(`/api/lds/notifications?lang=${encodeURIComponent(lang)}`),
  dismissJob: (id: string) => req<{ ok: boolean }>(`/api/lds/publish/jobs/${id}/dismiss`, { method: 'POST' }),
  dismissAllJobs: () => req<{ ok: boolean }>('/api/lds/publish/jobs/dismiss-all', { method: 'POST' }),
  publishDoc: (id: number, lang: string, mail?: MailPayload, autoMail?: boolean) => req<FlowResult>(`/api/lds/documents/${id}/publish?lang=${encodeURIComponent(lang)}`, { method: 'POST', body: JSON.stringify({ mail, autoMail }) }),
  releasePublishDoc: (id: number, lang: string, password?: string, mail?: MailPayload, publishMail?: MailPayload, autoMail?: boolean) => req<FlowResult>(`/api/lds/documents/${id}/release-publish?lang=${encodeURIComponent(lang)}`, { method: 'POST', body: JSON.stringify({ password, mail, publishMail, autoMail }) }),
  releaseDoc: (id: number, lang: string, password?: string, mail?: MailPayload, autoMail?: boolean) => req<FlowResult>(`/api/lds/documents/${id}/release?lang=${encodeURIComponent(lang)}`, { method: 'POST', body: JSON.stringify({ password, mail, autoMail }) }),
  mailOptions: () => req<MailOptions>('/api/lds/mail/options'),
  mailDraft: (id: number, lang: string, stage: 'release' | 'publish' | 'frozen', header?: string, footer?: string) =>
    req<MailDraft>(`/api/lds/documents/${id}/mail-draft?lang=${encodeURIComponent(lang)}&stage=${stage}${header !== undefined ? `&header=${encodeURIComponent(header)}` : ''}${footer !== undefined ? `&footer=${encodeURIComponent(footer)}` : ''}`),
  mailTest: (id: number, lang: string, mail: MailPayload) => req<{ sentTo: string }>(`/api/lds/documents/${id}/mail/test?lang=${encodeURIComponent(lang)}`, { method: 'POST', body: JSON.stringify(mail) }),
  mailLists: () => req<{ items: MailListItem[] }>('/api/lds/distribution'),
  mailList: (id: number) => req<MailListDetail>(`/api/lds/distribution/${id}`),
  createMailList: (name: string) => req<{ id: number }>('/api/lds/distribution', { method: 'POST', body: JSON.stringify({ name }) }),
  renameMailList: (id: number, name: string) => req<unknown>(`/api/lds/distribution/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }),
  deleteMailList: (id: number) => req<unknown>(`/api/lds/distribution/${id}`, { method: 'DELETE' }),
  addMailMembers: (id: number, ids: number[]) => req<{ added: number }>(`/api/lds/distribution/${id}/members`, { method: 'POST', body: JSON.stringify({ ids }) }),
  removeMailMember: (id: number, idec: number) => req<unknown>(`/api/lds/distribution/${id}/members/${idec}`, { method: 'DELETE' }),
  mailContacts: () => req<MailMember[]>('/api/lds/distribution/contacts'),
  addMailContact: (name: string, email: string) => req<{ idec: number; existed: boolean }>('/api/lds/distribution/contacts', { method: 'POST', body: JSON.stringify({ name, email }) }),
  changeMailContact: (idec: number, name: string, email: string) => req<unknown>(`/api/lds/distribution/contacts/${idec}`, { method: 'PUT', body: JSON.stringify({ name, email }) }),
  deleteMailContact: (idec: number) => req<unknown>(`/api/lds/distribution/contacts/${idec}`, { method: 'DELETE' }),
  docDistribution: (docId: number, lang: string) => req<DocDistribution>(`/api/lds/documents/${docId}/distribution?lang=${encodeURIComponent(lang)}`),
  addDocDistribution: (docId: number, lang: string, id: number) => req<unknown>(`/api/lds/documents/${docId}/distribution?lang=${encodeURIComponent(lang)}`, { method: 'POST', body: JSON.stringify({ id }) }),
  removeDocDistribution: (docId: number, lang: string, mlId: number) => req<unknown>(`/api/lds/documents/${docId}/distribution/${mlId}?lang=${encodeURIComponent(lang)}`, { method: 'DELETE' }),
  users: (status: string) => req<{ items: UserHead[]; activeCount: number; total: number }>(`/api/lds/users?status=${status}`),
  user: (id: number, lang: string) => req<{ head: UserHead; rights: RightItem[]; groups: IdLabel[] }>(`/api/lds/users/${id}?lang=${encodeURIComponent(lang)}`),
  userAllRights: (id: number, lang: string) => req<{ rights: RightItem[] }>(`/api/lds/users/${id}/all-rights?lang=${encodeURIComponent(lang)}`),
  rightsCatalog: (lang: string) => req<RightsCatalog>(`/api/lds/users/rights-catalog?lang=${encodeURIComponent(lang)}`),
  createUser: (b: UserBody) => req<{ idAcc: number }>('/api/lds/users', { method: 'POST', body: j(b) }),
  updateUser: (id: number, b: UserBody) => req<{ idAcc: number }>(`/api/lds/users/${id}`, { method: 'PUT', body: j(b) }),
  deleteUser: (id: number) => req<{ deleted: number }>(`/api/lds/users/${id}`, { method: 'DELETE' }),
  setUserPassword: (id: number, password: string) => req<{ idAcc: number }>(`/api/lds/users/${id}/password`, { method: 'POST', body: j({ password }) }),
  addUserRight: (id: number, rcod: number, rvalue: string) => req<{ id: number }>(`/api/lds/users/${id}/rights`, { method: 'POST', body: j({ rcod, rvalue }) }),
  delUserRight: (id: number, rid: number) => req<unknown>(`/api/lds/users/${id}/rights/${rid}`, { method: 'DELETE' }),
  addUserToGroup: (id: number, gid: number) => req<unknown>(`/api/lds/users/${id}/groups`, { method: 'POST', body: j({ id: gid }) }),
  delUserFromGroup: (id: number, gid: number) => req<unknown>(`/api/lds/users/${id}/groups/${gid}`, { method: 'DELETE' }),
  copyUserFrom: (id: number, from: number) => req<{ rightsAdded: number; groupsAdded: number }>(`/api/lds/users/${id}/copy-from`, { method: 'POST', body: j({ id: from }) }),
  simulateUser: (id: number) => req<{ token: string; expiresUtc: string; login: string; name: string }>(`/api/lds/users/${id}/simulate`, { method: 'POST' }),
  userGroups: () => req<IdLabel[]>('/api/lds/usergroups'),
  userGroup: (id: number, lang: string) => req<{ id: number; name: string; rights: RightItem[]; users: IdLabel[] }>(`/api/lds/usergroups/${id}?lang=${encodeURIComponent(lang)}`),
  createUserGroup: (name: string) => req<{ id: number }>('/api/lds/usergroups', { method: 'POST', body: j({ name }) }),
  renameUserGroup: (id: number, name: string) => req<unknown>(`/api/lds/usergroups/${id}`, { method: 'PUT', body: j({ name }) }),
  deleteUserGroup: (id: number) => req<unknown>(`/api/lds/usergroups/${id}`, { method: 'DELETE' }),
  addGroupRight: (id: number, rcod: number, rvalue: string) => req<{ id: number }>(`/api/lds/usergroups/${id}/rights`, { method: 'POST', body: j({ rcod, rvalue }) }),
  delGroupRight: (id: number, rid: number) => req<unknown>(`/api/lds/usergroups/${id}/rights/${rid}`, { method: 'DELETE' }),
  addGroupUser: (id: number, uid: number) => req<unknown>(`/api/lds/usergroups/${id}/users`, { method: 'POST', body: j({ id: uid }) }),
  delGroupUser: (id: number, uid: number) => req<unknown>(`/api/lds/usergroups/${id}/users/${uid}`, { method: 'DELETE' }),
  types: (lang: string) => req<{ items: TypeItem[]; canManage: boolean }>(`/api/lds/types?lang=${encodeURIComponent(lang)}`),
  createType: (b: TypeBody) => req<{ idType: number }>('/api/lds/types', { method: 'POST', body: JSON.stringify(b) }),
  updateType: (id: number, b: TypeBody) => req<{ idType: number }>(`/api/lds/types/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
  deleteType: (id: number) => req<{ deleted: number }>(`/api/lds/types/${id}`, { method: 'DELETE' }),
  setDefaultType: (id: number) => req<{ idType: number }>(`/api/lds/types/${id}/default`, { method: 'POST' }),
  filters: () => req<FilterHead[]>('/api/lds/filters'),
  filter: (id: number) => req<{ head: FilterHead; criteria: FilterCriteria }>(`/api/lds/filters/${id}`),
  filterOptions: (lang: string) => req<FilterOptions>(`/api/lds/filters/options?lang=${encodeURIComponent(lang)}`),
  createFilter: (b: FilterBody) => req<{ idFilter: number }>('/api/lds/filters', { method: 'POST', body: JSON.stringify(b) }),
  updateFilter: (id: number, b: FilterBody) => req<{ idFilter: number }>(`/api/lds/filters/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
  deleteFilter: (id: number) => req<{ deleted: number }>(`/api/lds/filters/${id}`, { method: 'DELETE' }),
  verifyFilter: (b: FilterBody) => req<{ count: number }>('/api/lds/filters/verify', { method: 'POST', body: JSON.stringify(b) }),
  lockInfo: (id: number) => req<{ locked: boolean; mine: boolean }>(`/api/lds/documents/${id}/lock`),
  checkOut: (id: number, lang: string) => req<{ checkedOut: boolean }>(`/api/lds/documents/${id}/checkout?lang=${encodeURIComponent(lang)}`, { method: 'POST' }),
  unlock: (id: number) => req<{ unlocked: boolean }>(`/api/lds/documents/${id}/unlock`, { method: 'POST' }),
  checkIn: (id: number, form: FormData) => req<CheckInResult>(`/api/lds/documents/${id}/checkin`, { method: 'POST', body: form }),
  copyDoc: (id: number, body: { lang: string; groupId: number; name: string; newName?: string; v1: number; v2: number; v3: number }) =>
    req<{ idDoc: number; name: string; version: string }>(`/api/lds/documents/${id}/copy`, { method: 'POST', body: JSON.stringify(body) }),
  docAssignments: (id: number, lang: string) => req<{ items: { idGroup: number; name: string; path: string; main: string }[]; hidden: number }>(`/api/lds/documents/${id}/assignments?lang=${encodeURIComponent(lang)}`),
  addAssignment: (id: number, lang: string, groupId: number) => req<{ added: boolean }>(`/api/lds/documents/${id}/assignments`, { method: 'POST', body: JSON.stringify({ lang, groupId }) }),
  removeAssignment: (id: number, lang: string, groupId: number) => req<unknown>(`/api/lds/documents/${id}/assignments/${groupId}?lang=${encodeURIComponent(lang)}`, { method: 'DELETE' }),
  renameDoc: (id: number, body: { lang: string; name: string; newName?: string }) => req<{ name: string; republish: boolean }>(`/api/lds/documents/${id}/rename`, { method: 'PUT', body: JSON.stringify(body) }),
  noWebDoc: (id: number, lang: string, hide: boolean) => req<{ hidden: boolean }>(`/api/lds/documents/${id}/noweb`, { method: 'POST', body: JSON.stringify({ lang, hide }) }),
  blockDoc: (id: number, lang: string, reason: string) => req<{ status: number }>(`/api/lds/documents/${id}/block`, { method: 'POST', body: JSON.stringify({ lang, reason }) }),
  unblockDoc: (id: number, lang: string, reason: string) => req<{ status: number }>(`/api/lds/documents/${id}/unblock`, { method: 'POST', body: JSON.stringify({ lang, reason }) }),
  deleteDoc: (id: number, lang: string) => req<{ warnings: string[] }>(`/api/lds/documents/${id}?lang=${encodeURIComponent(lang)}`, { method: 'DELETE' }),
  changeVersion: (id: number, body: { lang: string; v1: number; v2: number; v3: number; comment?: string }) =>
    req<VersionResult>(`/api/lds/documents/${id}/version`, { method: 'POST', body: JSON.stringify(body) }),
  docTypes: (lang: string) => req<{ types: DocTypeOpt[]; defaultType?: number }>(`/api/lds/doctypes?lang=${encodeURIComponent(lang)}`),
  login: (login: string, password: string) =>
    req<{ token: string; login: string }>('/api/lds/login', { method: 'POST', body: JSON.stringify({ login, password }) }),
  me: () => req<Me>('/api/lds/me'),
  languages: () => req<Lang[]>('/api/lds/languages'),
  stats: (lang: string) => req<Stats>(`/api/lds/stats?lang=${encodeURIComponent(lang)}`),
  groups: (lang: string, counts = true) => req<GroupTree>(`/api/lds/groups?lang=${encodeURIComponent(lang)}${counts ? '' : '&counts=false'}`),
  groupCounts: (lang: string) => req<{ counts: Record<string, number>; total: number; expired: number }>(`/api/lds/groups/counts?lang=${encodeURIComponent(lang)}`),
  groupLevel: (lang: string, parent: number) => req<GroupTree>(`/api/lds/groups?lang=${encodeURIComponent(lang)}&parent=${parent}&counts=false`),
  createGroup: (lang: string, idParent: number, name: string) => req<{ idGroup: number }>('/api/lds/groups', { method: 'POST', body: j({ lang, idParent, name }) }),
  renameGroup: (id: number, lang: string, name: string) => req<unknown>(`/api/lds/groups/${id}/rename`, { method: 'PUT', body: j({ lang, name }) }),
  deleteGroup: (id: number, lang: string) => req<unknown>(`/api/lds/groups/${id}?lang=${encodeURIComponent(lang)}`, { method: 'DELETE' }),
  processOwners: () => req<{ id: number; name: string }[]>('/api/lds/groups/process-owners'),
  setGroupOwner: (id: number, lang: string, idOwner: number) => req<{ documentsUpdated: number }>(`/api/lds/groups/${id}/owner?lang=${encodeURIComponent(lang)}`, { method: 'PUT', body: j({ idOwner }) }),
  setGroupWeb: (id: number, lang: string, value: boolean) => req<{ groups: number }>(`/api/lds/groups/${id}/web?lang=${encodeURIComponent(lang)}`, { method: 'PUT', body: j({ value }) }),
  setGroupPubOriginal: (id: number, lang: string, value: boolean) => req<unknown>(`/api/lds/groups/${id}/pub-original?lang=${encodeURIComponent(lang)}`, { method: 'PUT', body: j({ value }) }),
  setGroupTemplate: (id: number, lang: string, value: boolean) => req<unknown>(`/api/lds/groups/${id}/template?lang=${encodeURIComponent(lang)}`, { method: 'PUT', body: j({ value }) }),
  groupOrder: (id: number, lang: string) => req<GroupOrderData>(`/api/lds/groups/${id}/order?lang=${encodeURIComponent(lang)}`),
  saveGroupOrder: (id: number, lang: string, groups: number[], docs: number[]) => req<unknown>(`/api/lds/groups/${id}/order`, { method: 'PUT', body: j({ lang, groups, docs }) }),
  groupReport: (id: number, lang: string) => req<GroupReport>(`/api/lds/groups/${id}/report?lang=${encodeURIComponent(lang)}`),
  documents: (q: DocQuery) => {
    const p = new URLSearchParams();
    Object.entries(q).forEach(([k, v]) => v !== undefined && v !== '' && v !== false && p.set(k, String(v)));
    return req<DocPage>(`/api/lds/documents?${p}`);
  },
  document: (id: number, lang: string) => req<DocDetail>(`/api/lds/documents/${id}?lang=${encodeURIComponent(lang)}`),
};

const SIM = 'pl_sim_orig';
export const simulation = {
  /** Name of the simulated user while a simulation runs, else null. */
  active: () => { try { const j = sessionStorage.getItem(SIM); return j ? (JSON.parse(j) as { token: string; name: string; as: string }) : null; } catch { return null; } },
  start: (token: string, as: string) => { const orig = auth.get(); if (orig) { sessionStorage.setItem(SIM, JSON.stringify({ token: orig, name: '', as })); } auth.set(token); },
  stop: () => { const s = simulation.active(); if (s) auth.set(s.token); sessionStorage.removeItem(SIM); },
};

export async function downloadUserRights(lang: string): Promise<void> {
  const t = auth.get();
  const r = await fetch(`${BASE}/api/lds/users/export-rights?lang=${encodeURIComponent(lang)}`, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
  if (!r.ok) { let m = `Export failed (${r.status})`; try { const j = await r.json(); if (j?.error) m = j.error; } catch { /* no body */ } throw new Error(m); }
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement('a'); a.href = url; a.download = 'MS-LDS-User-Rights.csv'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
