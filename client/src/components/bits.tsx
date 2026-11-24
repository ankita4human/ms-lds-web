import type { DocRow } from '../api';

const STATUS_COLORS: Record<number, [string, string]> = {
  1: ['#eef2f6', '#475467'], 2: ['#fff4e0', '#b25e09'], 3: ['#e3f8ea', '#15803d'], 4: ['#e0f7f4', '#0f766e'],
  5: ['#eceff3', '#475467'], 6: ['#fde8e8', '#b42318'], 7: ['#e5efff', '#1d4ed8'], 8: ['#ece9ff', '#5b3fd6'],
  9: ['#fbdcdc', '#8a1313'], 11: ['#dff5fb', '#0e7490'],
};
export function StatusBadge({ id, name }: { id: number; name: string }) {
  const [bg, fg] = STATUS_COLORS[id] ?? ['#eef2f6', '#475467'];
  return <span className="badge" style={{ background: bg, color: fg }}>{name}</span>;
}

const EXT: Record<string, [string, string]> = {
  doc: ['DOC', '#2b579a'], docx: ['DOC', '#2b579a'], dot: ['DOT', '#2b579a'], dotx: ['DOT', '#2b579a'],
  xls: ['XLS', '#217346'], xlsx: ['XLS', '#217346'], xlsm: ['XLS', '#217346'],
  ppt: ['PPT', '#d24726'], pptx: ['PPT', '#d24726'], pdf: ['PDF', '#d92d20'],
  vsd: ['VSD', '#3955a3'], vsdx: ['VSD', '#3955a3'], txt: ['TXT', '#667085'],
};
export function ExtBadge({ ext }: { ext?: string }) {
  const key = (ext ?? '').replace('.', '').toLowerCase();
  const [label, color] = EXT[key] ?? [key.toUpperCase().slice(0, 4) || '-', '#98a2b3'];
  return <span className="ext" style={{ background: color }}>{label}</span>;
}

export const version = (d: Pick<DocRow, 'v1' | 'v2' | 'v3'>) => `${d.v1}.${d.v2}.${d.v3}`;
export const fmtDate = (s?: string) => (s ? new Date(s).toLocaleDateString('en-GB') : '-');
