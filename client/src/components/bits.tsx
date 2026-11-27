import type { DocRow } from '../api';
import { tr } from '../i18n';

const STATUS_COLORS: Record<number, [string, string]> = {
  1: ['#eef2f6', '#475467'], 2: ['#fff4e0', '#b25e09'], 3: ['#e3f8ea', '#15803d'], 4: ['#e0f7f4', '#0f766e'],
  5: ['#eceff3', '#475467'], 6: ['#fde8e8', '#b42318'], 7: ['#e5efff', '#1d4ed8'], 8: ['#ece9ff', '#5b3fd6'],
  9: ['#fbdcdc', '#8a1313'], 11: ['#dff5fb', '#0e7490'],
};
export function StatusBadge({ id, name }: { id: number; name: string }) {
  const [bg, fg] = STATUS_COLORS[id] ?? ['#eef2f6', '#475467'];
  return <span className="badge" style={{ background: bg, color: fg }}>{name}</span>;
}

type ExtInfo = { key: string; label: string; name: string; glyph: string; c1: string; c2: string };
const FAMILY: Record<string, Omit<ExtInfo, 'key' | 'label'>> = {
  word: { name: 'Word', glyph: 'W', c1: '#3b82f6', c2: '#1d4ed8' },
  excel: { name: 'Excel', glyph: 'X', c1: '#22c55e', c2: '#15803d' },
  ppt: { name: 'PowerPoint', glyph: 'P', c1: '#fb923c', c2: '#c2410c' },
  pdf: { name: 'PDF', glyph: 'PDF', c1: '#f87171', c2: '#b91c1c' },
  visio: { name: 'Visio', glyph: 'V', c1: '#818cf8', c2: '#4338ca' },
  text: { name: 'Text', glyph: 'TXT', c1: '#94a3b8', c2: '#475569' },
  image: { name: 'Image', glyph: 'IMG', c1: '#c084fc', c2: '#7e22ce' },
  zip: { name: 'Archive', glyph: 'ZIP', c1: '#fbbf24', c2: '#b45309' },
  other: { name: 'File', glyph: '•••', c1: '#a3b0c2', c2: '#64748b' },
};
const FAM_OF: Record<string, string> = {
  doc: 'word', docx: 'word', docm: 'word', dot: 'word', dotx: 'word', rtf: 'word', odt: 'word',
  xls: 'excel', xlsx: 'excel', xlsm: 'excel', xlsb: 'excel', csv: 'excel', ods: 'excel',
  ppt: 'ppt', pptx: 'ppt', pptm: 'ppt', pps: 'ppt', ppsx: 'ppt', odp: 'ppt',
  pdf: 'pdf', vsd: 'visio', vsdx: 'visio', txt: 'text', md: 'text', log: 'text', xml: 'text', json: 'text', htm: 'text', html: 'text',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', bmp: 'image', webp: 'image', svg: 'image', zip: 'zip', rar: 'zip', '7z': 'zip',
};
/** Colour family, product name and upper-case extension (DOCX, XLSX, PPTX ...) of a file extension. */
export function extInfo(ext?: string): ExtInfo {
  const key = (ext ?? '').replace(/^\./, '').trim().toLowerCase();
  const f = FAMILY[FAM_OF[key] ?? 'other']!;
  return { key, label: key ? key.toUpperCase().slice(0, 5) : 'FILE', ...f };
}

/** A small document sheet with a folded corner, coloured by file family (blue Word, green Excel, orange PowerPoint, red PDF ...). */
export function FileIcon({ ext, size = 30 }: { ext?: string; size?: number }) {
  const i = extInfo(ext);
  const id = `fi${i.key || 'x'}${i.name}`.replace(/[^a-z0-9]/gi, '');
  const long = i.glyph.length > 1;
  return (
    <svg className="fx-svg" width={Math.round(size * 0.82)} height={size} viewBox="0 0 28 34" role="img" aria-label={tr('{0} file', i.name)}>
      <defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={i.c1} /><stop offset="1" stopColor={i.c2} /></linearGradient></defs>
      <path d="M4 .5h13.2L27.5 10.8V30a3.5 3.5 0 0 1-3.5 3.5H4A3.5 3.5 0 0 1 .5 30V4A3.5 3.5 0 0 1 4 .5z" fill={`url(#${id})`} />
      <path d="M17.2.5v6.3a4 4 0 0 0 4 4h6.3z" fill="#fff" opacity=".38" />
      <rect x="3.5" y="14" width="21" height="14" rx="3" fill="#000" opacity=".12" />
      <text x="14" y={long ? 24.2 : 25} textAnchor="middle" fontSize={long ? 8.6 : 13} fontWeight="800" fill="#fff" fontFamily="system-ui,Segoe UI,Arial,sans-serif" letterSpacing={long ? '.3' : '0'}>{i.glyph}</text>
    </svg>
  );
}

/** File type for lists and cards: the icon plus the real extension (DOCX, XLSX, PPTX ...) and, unless `compact`, the product name. stacked = icon above text. */
export function ExtBadge({ ext, stacked, compact }: { ext?: string; stacked?: boolean; compact?: boolean }) {
  const i = extInfo(ext);
  return (
    <span className={`fx-ext${stacked ? ' stacked' : ''}`} style={{ ['--fc' as string]: i.c2 }} title={`${i.name} · ${ext ? '.' + i.key : 'no extension'}`}>
      <FileIcon ext={ext} size={stacked ? 32 : 28} />
      <span className="fx-ext-t"><b>{i.label}</b>{!compact && <small>{i.name}</small>}</span>
    </span>
  );
}

export const version = (d: Pick<DocRow, 'v1' | 'v2' | 'v3'>) => `${d.v1}.${d.v2}.${d.v3}`;
export const fmtDate = (s?: string) => (s ? new Date(s).toLocaleDateString('en-GB') : '-');
