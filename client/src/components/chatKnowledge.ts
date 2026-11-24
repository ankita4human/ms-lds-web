/* Knowledge base for the LDS assistant, written from the MS LDS user manual (202207) and the web app.
   Rule based and local: no external AI service. Each entry has keywords (with weights through repetition in `k`) and an answer in a tiny markdown
   subset (**bold**, "- " bullets, "1. " steps). `go` adds a button that opens the matching page. */

export type Kb = { id: string; title: string; k: string[]; a: string; detail?: string; go?: { label: string; to: string }; more?: string[] };

export const KB: Kb[] = [
  {
    id: 'lifecycle', title: 'Document status life cycle',
    k: ['status', 'life cycle', 'lifecycle', 'draft edit verified released published', 'what do the statuses mean', 'status meaning', 'status flow'],
    a: '**Status life cycle**\n1. **Draft**: a new document, only its author works on it.\n2. **Edit**: the document has been checked in after changes.\n3. **Verified**: a verifier has approved the content.\n4. **Released**: approved for use; version and expiry date are fixed.\n5. **Published**: copied to the web and sent to the distribution list.\n\nOnly verified documents can be released, and only released documents can be published. Frozen, Blocked and Archived are special states outside this flow.',
    more: ['How do I verify a document?', 'How do I release a document?', 'What is a frozen document?'],
  },
  {
    id: 'new', title: 'Add a new document',
    k: ['new document', 'add document', 'upload', 'create document', 'add new document', 'upload file', 'multiple files', 'drag and drop', 'template', 'reference'],
    a: '**Add a new document**\n1. Open **Documents** and click **New document** (or drop files on the page).\n2. Pick the folder (group) on the left of the dialog.\n3. Check name, type and language of each file. You can upload several files at once.\n4. Click **Upload**.\n\nThe document starts in **Draft** (default version **0.0.1**, the maximum is 999.999.999).',
    detail: '**More about new documents**\n- **Source**: *From file*, *From template* (a type flagged as template) or *Reference* (links to an existing document).\n- **Delete original**: tick it to remove the source file after the upload.\n- **Workflow**: choose a workflow in the same dialog and the document starts in it right away.\n- With several active **languages** the document is created in the language you have selected, translations follow when you release.\n- You need the *New document* right (or Administrator).',
    go: { label: 'Open Documents', to: '/documents' },
    more: ['What is a document type?', 'How do I edit a document?'],
  },
  {
    id: 'edit', title: 'Edit a document (check out / check in)',
    k: ['edit document', 'check out', 'checkout', 'check in', 'checkin', 'change document', 'modify document', 'new version', 'version number', 'minor major'],
    a: '**Edit a document**\n1. Right-click the document and choose **Check out**, then work on the file on your computer.\n2. Keep the **same file name** when you check it back in.\n3. Choose **Check in** and decide if it is a **major** or **minor** change. The version (V1.V2.V3) goes up accordingly.\n\nIf a document is in a workflow *Edit* step, only the assigned user can check it out. Administrators can also change the version number in any status (*Change version*).',
    detail: '**More about editing**\n- **Major** change = V1 goes up (and the expiry date is renewed). **Minor** = V2, **revision** = V3.\n- A document that is checked out is locked for others; *Cancel check-out* releases the lock.\n- Editing a document that exists in several languages: edit the main language first, translations are then updated on release.\n- An **expired** document can be edited in the main language and sent through verify → release → publish again.',
    go: { label: 'Open Documents', to: '/documents' },
  },
  {
    id: 'verify', title: 'Verify a document',
    k: ['verify', 'verified', 'verification', 'approve document', 'approval'],
    a: '**Verify a document**\nSelect the document, then use right-click menu → **Verify** (or the Verify button in the toolbar). The status becomes **Verified** and your name and the date are stored.\n\nYou need the *Verify* right. Inside a workflow, accepting a **Verify** step does this for you.\n\n*Note: only verified documents can be released and then published.*',
    go: { label: 'Open Documents', to: '/documents' },
    more: ['How do I release a document?'],
  },
  {
    id: 'release', title: 'Release a document',
    k: ['release', 'released', 'releasing', 'release document', 'expiry', 'expire date', 'expiration'],
    a: '**Release a document**\n1. The document must be **Verified**.\n2. Right-click → **Release**. If *Send default e-mails* is on you see the e-mail window where you can adjust recipients and text.\n3. If your system asks for it, confirm with your **password**.\n\nThe release date and the **expiry date** (type life in months) are set. Other languages follow the original language. Inside a workflow, accepting a **Release** step releases the document automatically.',
    detail: '**More about releasing**\n- With *Send default e-mails* on, the release e-mail goes to the distribution list of the document; you can edit recipients and text before it is sent.\n- The expiry date is only renewed for a **major** version change.\n- A release can be set to need your password (system option).',
    go: { label: 'Open Documents', to: '/documents' },
    more: ['How do I publish a document?'],
  },
  {
    id: 'publish', title: 'Publish a document',
    k: ['publish', 'published', 'publishing', 'publish document', 'web copy', 'pdf', 'distribution e-mail', 'publish job'],
    a: '**Publish a document**\n1. The document must be **Released**.\n2. Right-click → **Publish** (or **Release + Publish** to do both in one go).\n3. The job runs in the background; the **bell** in the top bar shows progress and result.\n\nThe publish e-mail goes to the distribution list of the document plus the CC list. Inside a workflow, accepting a **Publish** step queues the publishing.',
    detail: '**More about publishing**\n- The publish job writes the web copies (HTML / PDF / original, depending on the type) and sets the status to **Published**.\n- Renaming a published document sends it through the publish job again automatically.\n- *Do not publish* on a folder keeps its documents off the web.',
    go: { label: 'Open Documents', to: '/documents' },
  },
  {
    id: 'workflow', title: 'Workflow',
    k: ['workflow', 'work flow', 'cycle', 'steps', 'hand over', 'accept', 'reject', 'thumbs', 'add to workflow', 'start workflow', 'remove from workflow', 'workflow history', 'my tasks', 'task'],
    a: '**Workflow**\nA workflow moves a document through steps, each with a layer: **Edit → Verify → Release → Publish**.\n1. Right-click a document → **Add to workflow**, choose the workflow, the first step, the user and the due date.\n2. The assigned user sees it under **My tasks** (the number is shown in the menu and the bell) and gets an e-mail.\n3. They **accept** (hand over to the next step, or finish) or **reject** with a reason (back to the previous user).\n\nThe status follows the steps: Edit → *Edit*, Verify → *Verified*, Release → *Released*, Publish → *Published*. A document can be removed from the workflow at any stage, and the **History** tab lists every step.',
    detail: '**More about workflows**\n- You need the *Use workflow* right to add a document; the list of workflows can be filtered.\n- If a step has a **user group**, you choose which member of the group gets the task.\n- A document can be checked out from the workflow while it is in an Edit step.\n- Every run is stored as **workflow process history** (step, user, dates, remark).',
    go: { label: 'Open My tasks', to: '/tasks' },
    more: ['Show my pending tasks', 'How do I create a workflow?'],
  },
  {
    id: 'wfadmin', title: 'Create and manage workflows',
    k: ['create workflow', 'workflow management', 'new workflow', 'workflow steps', 'workflow admin', 'define workflow', 'workflow user group', 'editor of step'],
    a: '**Create a workflow**\n1. **Options → Workflow management** → *New workflow*.\n2. Add the steps in order, give each a **layer** (Edit, Verify, Release, Publish), a default **editor** or **user group**, and the **days** allowed.\n3. Choose the start step, the document types / folders / user groups it is valid for, and activate it.\n\nYou need the *Workflow management* right. Use the **test e-mail** button to check the notification mail.\n\nSteps are defined in order (you can move them up and down); the **task** is one of *Edit, Verify, Release, Publish*, the **processing time** is 0–100 days, and the first step is the starting point.',
    go: { label: 'Open Workflow management', to: '/options/workflows' },
  },
  {
    id: 'frozen', title: 'Frozen documents',
    k: ['frozen', 'freeze', 'defrost', 'defrozen', 'unfreeze', 'freeze document'],
    a: '**Frozen documents**\nFreezing locks a document so it cannot change or expire (version 999.999.999, *do not expire*). Use right-click → **Freeze**. To work on it again choose **Defrost**; the old version, expiry date and status are restored. Frozen documents are not part of the normal workflow.',
    go: { label: 'Open Documents', to: '/documents' },
  },
  {
    id: 'types', title: 'Document types',
    k: ['document type', 'type management', 'types', 'new type', 'life of document', 'short form', 'template type', 'publish as original'],
    a: '**Document types**\nUnder **Options → Type management** you create types with a **name**, a **short form**, the **life** in months (used for the expiry date) and flags such as *template*, *publish as original* and *14 days release*. A type cannot be deleted while documents use it.',
    go: { label: 'Open Type management', to: '/options/types' },
  },
  {
    id: 'users', title: 'Users, groups and rights',
    k: ['user', 'users', 'add user', 'new user', 'rights', 'privileges', 'permission', 'group rights', 'access group', 'password', 'user management', 'role', 'administrator', 'photo', 'profile picture'],
    a: '**Users, groups and rights**\nUnder **Options → User management** you add users, give them **rights** (for example Verify, Release, Publish, Workflow management, Administrator), put them in **groups** and give the groups access to folders. A user sees only documents in the folders his groups may access.\n\nNew users are **inactive** by default, the number of **active users cannot exceed the licences**, and a **password policy** applies. Users with the *Simulation* right can see the system as another user.\n\nYou can set your own **photo** with the pencil on your avatar in the sidebar; without one your initials are shown.',
    go: { label: 'Open User management', to: '/options/users' },
  },
  {
    id: 'filters', title: 'Filters',
    k: ['filter', 'filters', 'saved filter', 'filter management', 'search filter', 'advanced search', 'smart filter'],
    a: '**Filters**\nA filter stores a combination of criteria (status, type, author, dates, text…). Create and edit them under **Options → Filter management**; they then appear under **Filters** on the left of the Documents page, one click away.',
    go: { label: 'Open Filter management', to: '/options/filters' },
  },
  {
    id: 'standards', title: 'Standards',
    k: ['standard', 'standards', 'mandatory standard', 'import standard', 'standard group'],
    a: '**Standards**\nStandards are special folders (shown under **Standard** in the tree). In **Options → Standard management** you can add, edit, remove, import and search standards and mark some as **mandatory**. A mandatory standard must be assigned before a document can be released.',
    go: { label: 'Open Standard management', to: '/options/standards' },
  },
  {
    id: 'dependency', title: 'Dependencies and links',
    k: ['dependency', 'dependencies', 'links', 'link', 'broken link', 'broken links', 'related document', 'create links'],
    a: '**Dependencies and links**\n**Dependency management** shows which documents are linked and lets you change type, name or author for many at once. Links you put into a document are checked; **Options → Program options → Admin → Broken links** lists the ones that no longer point to a released document.',
    go: { label: 'Open Dependency', to: '/options/dependency' },
  },
  {
    id: 'catch', title: 'Catchwords',
    k: ['catch', 'catchword', 'catch management', 'keyword', 'keywords', 'catchwords'],
    a: '**Catchwords**\nCatchwords are keywords that make documents easier to find on the MS LDS website.\n- **Options → Catch management**: activate or deactivate catchwords (several at once) and edit them.\n- In a document\'s **Catch tab** you add a catchword (**Add**, type it, OK), activate or deactivate it.\n- A catchword needs at least **4 letters**; 3-letter words must be allowed under *Program options → Admin*.\n- Application catchwords are managed in **Program options → Admin**.',
    go: { label: 'Open Catch management', to: '/options/catch' },
  },
  {
    id: 'tags', title: 'Tags',
    k: ['tag', 'tags', 'placeholder', '$$', 'replacement', 'template tag', 'variable in e-mail', 'application tag'],
    a: '**Tags**\nTags are placeholders such as `$$name$$` that are replaced by real values in documents and e-mails. **Options → Tags** lists them: choose the application, click a tag to copy it, paste it into your template. Application-level tags can be changed in **Program options → Admin** and keep a history.',
    go: { label: 'Open Tags', to: '/options/tags' },
  },
  {
    id: 'mail', title: 'E-mail and distribution lists',
    k: ['e-mail', 'email', 'mail', 'distribution', 'distribution list', 'smtp', 'notification mail', 'mail not working', 'mail not sent', 'cc list', 'recipient'],
    a: '**E-mail and distribution lists**\nPublish and release e-mails go to the **distribution lists** of the document (**Options → E-mail distribution**) plus the CC list. Workflow mails go to the assigned user. If mails do not arrive, check the SMTP settings (server, sender, login) in the configuration and use **Workflow management → Send test e-mail to me**. The server log shows the reason for a failure.',
    go: { label: 'Open E-mail distribution', to: '/options/distribution' },
  },
  {
    id: 'delete', title: 'Delete, rename, copy a document',
    k: ['delete document', 'remove document', 'rename', 'copy document', 'duplicate', 'archive', 'deleted documents', 'restore'],
    a: '**Delete, copy**\n- **Copy**: right-click → *Copy document* opens the New document window with the data filled in; the distribution list can be copied too.\n- **Delete**: right-click → *Delete*. Deleted documents stay in the archive; administrators see them under **Program options → Admin → Deleted documents**.',
    go: { label: 'Open Documents', to: '/documents' },
  },
  {
    id: 'rename', title: 'Rename a document',
    k: ['rename', 'rename document', 'change name', 'f2', 'new name'],
    a: '**Rename a document**\n1. Select the document and press **F2** (or right-click → *Rename*).\n2. Type the new name and press **Enter**.\n\nIn the standard setup only **Draft** and **Edit** documents can be renamed; with the option *Rename in every status* switched on you can rename at any time, and a **published** document goes through the publish job again automatically.',
    go: { label: 'Open Documents', to: '/documents' },
  },
  {
    id: 'assign', title: 'Assign a document to another folder',
    k: ['assign', 'assignment', 'assignments', 'assign document', 'more than one folder', 'second folder', 'move document', 'folder of document', 'group of document'],
    a: '**Assign a document to a folder**\n1. Select the document and choose **Assignments** (right-click menu).\n2. Double-click the folder (group) you want and confirm with **OK**.\n\nThe assignment is then listed on the **Assignments** tab of the document properties, with group id and chapter number. A document can live in several folders.',
    go: { label: 'Open Documents', to: '/documents' },
  },
  {
    id: 'simulate', title: 'Simulate a user profile',
    k: ['simulate', 'simulation', 'simulate user', 'see as user', 'impersonate', 'act as user', 'view as another user'],
    a: '**Simulate a user profile**\nWith the *Simulation* right, **Options → Simulate profile** lets you choose an active user and open the system with that person\'s rights and folder access, which is ideal for checking why somebody cannot see or do something.',
    go: { label: 'Open User management', to: '/options/users' },
  },
  {
    id: 'owner', title: 'Process owner',
    k: ['process owner', 'owner', 'owner of document', 'no process owner', 'never edited', 'never verified', 'special filter'],
    a: '**Process owner**\nA folder can have a **process owner**; the Documents grid can show it as a column. The special filters **No process owner**, **Never edited** and **Never verified** help to find documents that nobody looks after.',
    go: { label: 'Open Documents', to: '/documents' },
  },
  {
    id: 'archive', title: 'Archive and version history',
    k: ['history', 'old version', 'previous version', 'archive', 'version history', 'document history', 'who changed', 'control'],
    a: '**Version history**\nOpen a document and look at its **Versions / History** tab: every check-in and status change is stored with user, date and comment, and old versions can be opened from the archive.',
    go: { label: 'Open Documents', to: '/documents' },
  },
  {
    id: 'expire', title: 'Expiry',
    k: ['expired', 'expire', 'expiring', 'do not expire', 'expiry date', 'overdue document', 'life'],
    a: '**Expiry**\nThe expiry date is set at release from the type\'s *life* in months (a document can be marked *do not expire*). Expired documents are listed under **Expired documents** in the tree and counted on the dashboard (*expiring soon* as well). Edit an expired document, then verify, release and publish it again.',
    go: { label: 'Open Documents', to: '/documents' },
  },
  {
    id: 'webhistory', title: 'Web history and admin options',
    k: ['web history', 'admin options', 'program options', 'broken links', 'deleted documents', 'simulate profile', 'who read', 'who opened'],
    a: '**Admin options**\n**Options → Program options → Admin** has: deleted documents, broken links, web history (who opened which document on the web), application catchwords and application-level tags. It is visible for administrators only.',
    go: { label: 'Open Program options', to: '/options/program' },
  },
  {
    id: 'theme', title: 'Theme, profile and settings',
    k: ['dark mode', 'theme', 'light mode', 'night', 'colour', 'color', 'appearance', 'profile', 'language', 'switch language', 'change language'],
    a: '**Appearance and language**\nUse the three-way switch in the top bar for **Normal**, **Light** or **Dark**. The **Language** selector next to it switches the documents you see (EN/DE/PL…). Your picture and name are in the sidebar and the profile menu.',
  },
  {
    id: 'analytics', title: 'Dashboard and analytics',
    k: ['dashboard', 'analytics', 'chart', 'charts', 'statistics', 'kpi', 'report', 'overview'],
    a: '**Dashboard and analytics**\nThe **Dashboard** shows totals per status, type, author and year; **Analytics** goes deeper with charts you can click through. Lists can be exported to Excel/CSV from the Documents page.',
    go: { label: 'Open Analytics', to: '/analytics' },
  },
  {
    id: 'shortcuts', title: 'Shortcuts',
    k: ['shortcut', 'shortcuts', 'keyboard', 'hotkey', 'f2', 'right click', 'context menu'],
    a: '**Handy shortcuts**\n- **F2** renames the selected document or folder.\n- **Right-click** on a folder, a document or the tree root opens the matching menu.\n- **Double-click** a folder to expand it; use the arrows in the tree header to expand or collapse all.\n- **Esc** closes this assistant.',
  },
  {
    id: 'about', title: 'About MS LDS',
    k: ['what is lds', 'about', 'ms lds', 'qds', 'what is this', 'what is msqf', 'licence', 'license', 'version of program'],
    a: '**MS LDS®** (from MS QF GmbH) is a document management system for controlled documents: folders, versions, check-out/check-in, verification, release, publishing, workflows, e-mail notification and full history. This web app offers the same functions as the Windows client in a modern admin panel.',
  },
];

const STOP = new Set('the a an of for to in on is are do does did how what where when why which can could i you my me we it this that and or with without from by be about please tell show explain need want would should'.split(' '));
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9$äöüß ]/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w));
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, '');

/** Scores every entry against a question; returns the best matches (score >= minimum), best first. */
export function lookup(question: string, limit = 3): { e: Kb; score: number }[] {
  const qw = words(question).map(stem);
  const text = question.toLowerCase();
  if (qw.length === 0) return [];
  const out = KB.map(e => {
    let score = 0;
    for (const key of e.k) {
      if (text.includes(key)) score += 3 + key.split(' ').length;            // whole phrase present: strong
      else { const kw = words(key).map(stem); const hit = kw.filter(w => qw.includes(w)).length; if (hit) score += hit / kw.length; }
    }
    const tw = words(e.title).map(stem); score += tw.filter(w => qw.includes(w)).length * 1.5;
    return { e, score };
  }).filter(x => x.score >= 1.2).sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

export const STEM = stem;
/** Vocabulary of every word used in keywords and titles, for typo correction. */
let VOC: Set<string> | null = null;
export function vocab(): Set<string> { if (!VOC) { VOC = new Set(); for (const e of KB) for (const t of [...e.k, e.title]) for (const w of words(t)) VOC.add(w); } return VOC; }
export function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}
/** Fixes small typos ("relese", "publsih", "workfow") by snapping to the closest known word. */
export function fixTypos(text: string): string {
  const voc = vocab();
  return text.replace(/[a-zäöüß]{4,}/gi, w => {
    const lw = w.toLowerCase(); if (voc.has(lw) || voc.has(stem(lw))) return w;
    let best = '', bd = 9; const max = lw.length >= 8 ? 2 : 1;
    for (const v of voc) { if (v.length < 4) continue; const d = lev(lw, v); if (d < bd) { bd = d; best = v; } }
    return bd <= max ? best : w;
  });
}
