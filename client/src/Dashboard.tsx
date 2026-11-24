import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { api, type Stat } from './api';
import { useLang } from './LangContext';
import { TrackColumns, YearLines, PALETTE } from './components/charts';
import { fmtDate } from './components/bits';
import { PageLoader } from './components/Loader';

const dots = <span className="dots">•••</span>;

function Spark({ data, color }: { data: number[]; color: string }) {
  const max = Math.max(1, ...data);
  return (
    <div className="spark" aria-hidden="true">
      {data.map((n, i) => (
        <span key={i} style={{ height: `${Math.max(8, (n / max) * 100)}%`, background: i === data.length - 1 ? color : `${color}33` }} />
      ))}
    </div>
  );
}
const Meter = ({ pct, color }: { pct: number; color: string }) => <div className="meter"><span style={{ width: `${pct}%`, background: color }} /></div>;

function Kpi({ title, value, color, spark, pct, delta }: {
  title: string; value?: number; color: string; spark?: number[]; pct?: number; delta?: ReactNode;
}) {
  return (
    <div className="card kpi2">
      <div className="card-head"><span className="t">{title}</span>{dots}</div>
      <div className="row">
        <div>
          <div className="num">{value ?? '...'}</div>
          <div className="delta"><i style={{ background: color }} />{delta}</div>
        </div>
        {spark && spark.length > 1 ? <Spark data={spark} color={color} /> : <Meter pct={pct ?? 0} color={color} />}
      </div>
    </div>
  );
}

const yoy = (s: Stat[]) => {
  if (s.length < 2) return undefined;
  const [prev, last] = [s[s.length - 2].count, s[s.length - 1].count];
  return prev ? Math.round(((last - prev) / prev) * 1000) / 10 : undefined;
};
const initials = (n: string) => n.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';

export default function Dashboard() {
  const { lang } = useLang();
  const q = useQuery({ queryKey: ['stats', lang], queryFn: () => api.stats(lang), enabled: !!lang });
  const s = q.data; const k = s?.kpi;
  const total = k?.total ?? 0;
  const pct = (n?: number) => (total ? Math.round(((n ?? 0) / total) * 1000) / 10 : 0);
  const created = (s?.createdByYear ?? []); const published = (s?.publishedByYear ?? []);
  const cDelta = yoy(created); const pDelta = yoy(published);
  const arrow = (d?: number) => (d === undefined ? 'per year' : <>{d >= 0 ? '▲' : '▼'} {Math.abs(d)}% vs prev. year</>);
  const status = s?.byStatus ?? [];
  const topAuthor = Math.max(1, ...(s?.byAuthor ?? []).map(a => a.count));

  if (q.isLoading || !lang) return <PageLoader label="Loading dashboard" />;

  return (
    <section>
      {q.isError && <div className="card error" role="alert" style={{ marginBottom: 16 }}>Could not load statistics.</div>}
      <div className="grid kpis">
        <Kpi title={`Documents (${lang})`} value={k?.total} color="#2f6df6" spark={created.slice(-8).map(x => x.count)} delta={arrow(cDelta)} />
        <Kpi title="Published" value={k?.published} color="#22c55e" spark={published.slice(-8).map(x => x.count)} delta={arrow(pDelta)} />
        <Kpi title="Draft / in edit" value={(k?.draft ?? 0) + (k?.edit ?? 0)} color="#f97316" pct={pct((k?.draft ?? 0) + (k?.edit ?? 0))} delta={`${pct((k?.draft ?? 0) + (k?.edit ?? 0))}% of all`} />
        <Kpi title="Verified / released" value={(k?.verified ?? 0) + (k?.released ?? 0)} color="#7c3aed" pct={pct((k?.verified ?? 0) + (k?.released ?? 0))} delta={`${pct((k?.verified ?? 0) + (k?.released ?? 0))}% of all`} />
        <Kpi title="Expired" value={k?.expired} color="#ef4444" pct={pct(k?.expired)} delta={`${k?.expiringSoon ?? 0} more expire within 30 days`} />
      </div>

      <div className="grid row-2-1">
        <div className="card">
          <div className="card-head"><div><h3>Document growth</h3><div className="hint">Created vs published per year</div></div>{dots}</div>
          <div className="chart tall"><YearLines a={created} b={published} aName="Created" bName="Published" /></div>
        </div>
        <div className="card">
          <div className="card-head"><div><h3>Document types</h3><div className="hint">Top 10 types in this language</div></div>{dots}</div>
          <div className="chart tall"><TrackColumns data={(s?.byType ?? []).slice(0, 10)} /></div>
        </div>
      </div>

      <div className="grid row-3" style={{ marginTop: 18 }}>
        <div className="card">
          <div className="card-head"><div><h3>Author activity</h3><div className="hint">Documents created, top 5</div></div>{dots}</div>
          <div className="ulist">
            {(s?.byAuthor ?? []).slice(0, 5).map((a, i) => (
              <div className="urow" key={a.label}>
                <div className="ini" style={{ background: PALETTE[i % PALETTE.length] }}>{initials(a.label)}</div>
                <span>{a.label}</span>
                <div className="bar"><span style={{ width: `${(a.count / topAuthor) * 100}%`, background: PALETTE[i % PALETTE.length] }} /></div>
                <span className="pc" style={{ color: PALETTE[i % PALETTE.length] }}>{a.count}</span>
              </div>
            ))}
            {!s?.byAuthor?.length && <div className="empty" style={{ height: 120 }}>No data</div>}
          </div>
        </div>

        <div className="card">
          <div className="card-head"><div><h3>Status channels</h3><div className="hint">Documents by lifecycle status</div></div>{dots}</div>
          <div className="donut-wrap">
            <div className="donut-box">
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={status} dataKey="count" nameKey="label" innerRadius="68%" outerRadius="92%" paddingAngle={2} stroke="none">
                    {status.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
              <div className="donut-center"><b>{total}</b><small>Documents</small></div>
            </div>
            <div className="legend">
              {status.slice(0, 6).map((x, i) => (
                <div key={x.label}><i style={{ borderColor: PALETTE[i % PALETTE.length] }} /><span>{x.label}</span><b>{pct(x.count)}%</b></div>
              ))}
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><div><h3>Expiring soon</h3><div className="hint">Next documents to expire</div></div>{dots}</div>
          <table className="mini-table">
            <thead><tr><th>Document</th><th>Expires</th><th>In</th></tr></thead>
            <tbody>
              {(s?.expiringDocs ?? []).map(d => {
                const days = d.dateExp ? Math.ceil((new Date(d.dateExp).getTime() - Date.now()) / 86400000) : 0;
                const hot = days <= 30;
                return (
                  <tr key={d.idDoc}>
                    <td className="nm" title={d.docName}>{d.docName}</td><td>{fmtDate(d.dateExp)}</td>
                    <td><span className="pill" style={{ background: hot ? '#fde8e8' : '#e3f8ea', color: hot ? '#b42318' : '#15803d' }}>{days} d</span></td>
                  </tr>
                );
              })}
              {s && !s.expiringDocs?.length && <tr><td colSpan={3} style={{ color: 'var(--muted)' }}>Nothing is about to expire.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
