import type { ReactNode } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Stat } from '../api';

export const PALETTE = ['#1b5fa7', '#c8851f', '#16a34a', '#7c3aed', '#e11d48', '#0891b2', '#f59e0b', '#64748b', '#db2777', '#4f46e5'];

export function ChartCard({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <div className="card"><h3>{title}</h3>{hint && <div className="hint">{hint}</div>}<div className="chart">{children}</div></div>;
}
const Empty = () => <div className="empty">No data</div>;

export function Donut({ data }: { data: Stat[] }) {
  if (!data.length) return <Empty />;
  return (
    <ResponsiveContainer>
      <PieChart>
        <Pie data={data} dataKey="count" nameKey="label" innerRadius="55%" outerRadius="80%" paddingAngle={2}>
          {data.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
        </Pie>
        <Tooltip /><Legend verticalAlign="bottom" height={36} />
      </PieChart>
    </ResponsiveContainer>
  );
}

/** Horizontal bars: good for long labels such as document types or user names. */
export function HBars({ data, color = PALETTE[0] }: { data: Stat[]; color?: string }) {
  if (!data.length) return <Empty />;
  return (
    <ResponsiveContainer>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16 }}>
        <CartesianGrid strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" allowDecimals={false} />
        <YAxis type="category" dataKey="label" width={130} tick={{ fontSize: 12 }} />
        <Tooltip /><Bar dataKey="count" fill={color} radius={[0, 6, 6, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function Columns({ data, color = PALETTE[0] }: { data: Stat[]; color?: string }) {
  if (!data.length) return <Empty />;
  return (
    <ResponsiveContainer>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 12 }} /><YAxis allowDecimals={false} />
        <Tooltip /><Bar dataKey="count" fill={color} radius={[6, 6, 0, 0]}>
          {data.map((_, i) => <Cell key={i} fill={color === 'multi' ? PALETTE[i % PALETTE.length] : color} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Two yearly series on one area chart (created vs published). */
export function YearCompare({ a, b, aName, bName }: { a: Stat[]; b: Stat[]; aName: string; bName: string }) {
  const years = Array.from(new Set([...a, ...b].map(x => x.label))).sort();
  const data = years.map(y => ({ year: y, [aName]: a.find(x => x.label === y)?.count ?? 0, [bName]: b.find(x => x.label === y)?.count ?? 0 }));
  if (!data.length) return <Empty />;
  return (
    <ResponsiveContainer>
      <AreaChart data={data}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="year" /><YAxis allowDecimals={false} /><Tooltip /><Legend />
        <Area type="monotone" dataKey={aName} stroke={PALETTE[0]} fill={PALETTE[0]} fillOpacity={0.22} />
        <Area type="monotone" dataKey={bName} stroke={PALETTE[1]} fill={PALETTE[1]} fillOpacity={0.22} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Smooth lines for two yearly series (created vs published), as in the reference dashboard. */
export function YearLines({ a, b, aName, bName }: { a: Stat[]; b: Stat[]; aName: string; bName: string }) {
  const years = Array.from(new Set([...a, ...b].map(x => x.label))).sort();
  const data = years.map(y => ({ year: y, [aName]: a.find(x => x.label === y)?.count ?? 0, [bName]: b.find(x => x.label === y)?.count ?? 0 }));
  if (!data.length) return <Empty />;
  return (
    <ResponsiveContainer>
      <LineChart data={data} margin={{ left: -10, right: 8 }}>
        <CartesianGrid stroke="#eef1f6" vertical={false} />
        <XAxis dataKey="year" tickLine={false} axisLine={false} tick={{ fill: '#98a2b3', fontSize: 12 }} />
        <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: '#98a2b3', fontSize: 12 }} />
        <Tooltip contentStyle={{ borderRadius: 10, border: 0, boxShadow: '0 8px 24px rgba(16,24,40,.18)' }} />
        <Line type="monotone" dataKey={aName} stroke="#2f6df6" strokeWidth={2.5} dot={false} activeDot={{ r: 5 }} />
        <Line type="monotone" dataKey={bName} stroke="#cfd6e4" strokeWidth={2.5} dot={false} activeDot={{ r: 5 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Blue columns on a light grey track, as in the reference "Impressions" chart. */
export function TrackColumns({ data }: { data: Stat[] }) {
  if (!data.length) return <Empty />;
  const short = (l: string) => (l.length > 9 ? l.slice(0, 8) + '…' : l);
  return (
    <ResponsiveContainer>
      <BarChart data={data} margin={{ left: -10, right: 4 }}>
        <XAxis dataKey="label" tickFormatter={short} tickLine={false} axisLine={false} interval={0} tick={{ fill: '#98a2b3', fontSize: 11 }} />
        <YAxis hide allowDecimals={false} />
        <Tooltip cursor={false} contentStyle={{ borderRadius: 10, border: 0, boxShadow: '0 8px 24px rgba(16,24,40,.18)' }} />
        <Bar dataKey="count" fill="#2f6df6" radius={[4, 4, 4, 4]} barSize={14} background={{ fill: '#eef1f6', radius: 4 }} />
      </BarChart>
    </ResponsiveContainer>
  );
}
