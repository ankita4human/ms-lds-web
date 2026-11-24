import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useLang } from './LangContext';
import { PageLoader } from './components/Loader';
import { ChartCard, Columns, Donut, HBars, PALETTE } from './components/charts';

export default function Analytics() {
  const { lang } = useLang();
  const q = useQuery({ queryKey: ['stats', lang], queryFn: () => api.stats(lang), enabled: !!lang });
  const s = q.data;
  if (q.isLoading || !lang) return <PageLoader label="Loading analytics" />;
  return (
    <section>
      {q.isError && <div className="card error" role="alert">Could not load statistics.</div>}
      <h2 style={{ margin: '0 0 12px' }}>User views <small style={{ color: 'var(--muted)', fontWeight: 400 }}>({lang})</small></h2>
      <div className="grid cols-3">
        <ChartCard title="Authors" hint="Top 10 by documents created"><HBars data={s?.byAuthor ?? []} color={PALETTE[0]} /></ChartCard>
        <ChartCard title="Publishers" hint="Top 10 by documents published"><HBars data={s?.byPublisher ?? []} color={PALETTE[2]} /></ChartCard>
        <ChartCard title="Releasers" hint="Top 10 by documents released"><HBars data={s?.byReleaser ?? []} color={PALETTE[3]} /></ChartCard>
      </div>
      <h2 style={{ margin: '24px 0 12px' }}>Document views</h2>
      <div className="grid cols-3">
        <ChartCard title="Status" hint="Lifecycle status"><Donut data={s?.byStatus ?? []} /></ChartCard>
        <ChartCard title="File format" hint="Document file types"><Donut data={s?.byExtension ?? []} /></ChartCard>
        <ChartCard title="Language" hint="Documents per language"><Columns data={s?.byLanguage ?? []} color="multi" /></ChartCard>
      </div>
      <div className="grid cols-2" style={{ marginTop: 18 }}>
        <ChartCard title="Document types" hint="All types"><HBars data={s?.byType ?? []} color={PALETTE[1]} /></ChartCard>
        <ChartCard title="Expiry" hint="Time until documents expire"><Columns data={s?.expiry ?? []} color="multi" /></ChartCard>
      </div>
    </section>
  );
}
