import type { GroupReport, DocRow } from './api';
import { api } from './api';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const day = (s?: string) => (s ? new Date(s).toLocaleDateString('en-GB') : '-');
const ver = (d: DocRow) => `${d.v1}.${d.v2}.${d.v3}`;

const STYLE = `body{font:12px/1.4 Segoe UI,Arial,sans-serif;color:#1d2433;margin:24px}h1{font-size:20px;margin:0 0 2px}.sub{color:#667085;margin-bottom:16px}
h2{font-size:14px;margin:18px 0 6px;padding:5px 8px;background:#eef2ff;border-left:4px solid #4f46e5;break-after:avoid}
table{border-collapse:collapse;width:100%;margin-bottom:6px}th{background:#f2f4f9;text-align:left}th,td{border:1px solid #d5dbe7;padding:4px 6px;vertical-align:top}
tr{break-inside:avoid}.none{color:#98a2b3;font-style:italic}.bar{position:sticky;top:0;background:#fff;padding:8px 0;margin-bottom:8px}
button{padding:7px 16px;border:0;border-radius:8px;background:#4f46e5;color:#fff;font-size:13px;cursor:pointer}@media print{.bar{display:none}body{margin:10mm}}`;

/** Opens the print preview window. The browser's print dialog turns it into paper or PDF. */
function openPage(title: string, sub: string, body: string): boolean {
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${STYLE}</style></head><body>
    <div class="bar"><button onclick="window.print()">Print / Save as PDF</button></div><h1>${esc(title)}</h1><div class="sub">${esc(sub)}</div>${body}</body></html>`);
  w.document.close();
  return true;
}

/** Print list of a group: every document of the group and its sub-groups (legacy "Print Report"). */
export function printGroupReport(r: GroupReport): boolean {
  const head = '<tr><th>ID</th><th>Document</th><th>Type</th><th>Version</th><th>Author</th><th>Created</th><th>Editor</th><th>Modified</th><th>Publisher</th><th>Published</th></tr>';
  const body = r.sections.map(s => `<h2>${esc(s.path)}</h2>` + (s.docs.length === 0 ? '<div class="none">No documents</div>'
    : `<table>${head}${s.docs.map(d => `<tr><td>${d.idDoc}</td><td>${esc(d.name)}</td><td>${esc(d.type)}</td><td>${esc(d.version)}</td><td>${esc(d.author ?? '-')}</td><td>${day(d.created)}</td><td>${esc(d.editor ?? '-')}</td><td>${day(d.modified)}</td><td>${esc(d.publisher ?? '-')}</td><td>${day(d.published)}</td></tr>`).join('')}</table>`)).join('');
  return openPage(`Print list ${r.title}`, `${r.documents} document(s) · ${r.lang} · ${new Date(r.generated).toLocaleString('en-GB')}`, body);
}

/** Every document of a saved filter, page by page (the list endpoint returns at most 200 per call). */
export async function allFilterDocs(filterId: number, lang: string): Promise<DocRow[]> {
  const out: DocRow[] = [];
  for (let page = 1; page <= 50; page++) {
    const r = await api.documents({ page, pageSize: 200, lang, filterId, sort: 'name', desc: false });
    out.push(...r.items);
    if (out.length >= r.total || r.items.length === 0) break;
  }
  return out;
}

export function printFilterReport(name: string, docs: DocRow[]): boolean {
  const rows = docs.map(d => `<tr><td>${d.idDoc}</td><td>${esc(d.docName)}</td><td>${esc(d.statusName)}</td><td>${esc(d.typeName)}</td><td>${ver(d)}</td><td>${esc(d.creator ?? '-')}</td><td>${day(d.dateCre)}</td><td>${esc(d.publisher ?? '-')}</td><td>${day(d.datePub)}</td><td>${day(d.dateExp)}</td></tr>`).join('');
  return openPage(`Filter report ${name}`, `${docs.length} document(s) · ${new Date().toLocaleString('en-GB')}`,
    `<table><tr><th>ID</th><th>Document</th><th>Status</th><th>Type</th><th>Version</th><th>Creator</th><th>Created</th><th>Publisher</th><th>Published</th><th>Expires</th></tr>${rows}</table>`);
}

/** Excel opens this directly: UTF-8 with BOM, ';' as separator is not assumed, values are quoted. */
export function downloadCsv(file: string, rows: (string | number | undefined | null)[][]) {
  const text = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿', text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = file; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function filterCsvRows(docs: DocRow[]) {
  return [['ID', 'Document', 'Status', 'Type', 'Version', 'Language', 'Creator', 'Created', 'Modified', 'Publisher', 'Published', 'Released', 'Expires'],
    ...docs.map(d => [d.idDoc, d.docName, d.statusName, d.typeName, ver(d), d.lang, d.creator, day(d.dateCre), day(d.dateMod), d.publisher, day(d.datePub), day(d.dateRel), day(d.dateExp)])];
}

export const safeFile = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'export';
