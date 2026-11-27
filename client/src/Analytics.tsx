import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useLang } from './LangContext';
import { PageLoader } from './components/Loader';
import { ChartCard, Columns, Donut, HBars, PALETTE } from './components/charts';
import { tr } from './i18n';

export default function Analytics() {
  const { lang } = useLang();
  const q = useQuery({ queryKey: ['stats', lang], queryFn: () => api.stats(lang), enabled: !!lang });
  const s = q.data;
  if (q.isLoading || !lang) return <PageLoader label={tr('Loading analytics')} />;
  return (
    <section>
      {q.isError && <div className="card error" role="alert">{tr('Could not load statistics.')}</div>}
      <div className="sec-title">{tr('User views')}<small>{lang}</small></div>
      <div className="grid cols-3">
        <ChartCard title={tr('Authors')} hint={tr('Top 10 by documents created')}><HBars data={s?.byAuthor ?? []} color={PALETTE[0]} /></ChartCard>
        <ChartCard title={tr('Publishers')} hint={tr('Top 10 by documents published')}><HBars data={s?.byPublisher ?? []} color={PALETTE[2]} /></ChartCard>
        <ChartCard title={tr('Releasers')} hint={tr('Top 10 by documents released')}><HBars data={s?.byReleaser ?? []} color={PALETTE[3]} /></ChartCard>
      </div>
      <div className="sec-title" style={{ marginTop: 26 }}>{tr('Document views')}</div>
      <div className="grid cols-3">
        <ChartCard title={tr('Status')} hint={tr('Lifecycle status')}><Donut data={s?.byStatus ?? []} /></ChartCard>
        <ChartCard title={tr('File format')} hint={tr('Document file types')}><Donut data={s?.byExtension ?? []} /></ChartCard>
        <ChartCard title={tr('Language')} hint={tr('Documents per language')}><Columns data={s?.byLanguage ?? []} color="multi" /></ChartCard>
      </div>
      <div className="grid cols-2" style={{ marginTop: 18 }}>
        <ChartCard title={tr('Document types')} hint={tr('All types')}><HBars data={s?.byType ?? []} color={PALETTE[1]} /></ChartCard>
        <ChartCard title={tr('Expiry')} hint={tr('Time until documents expire')}><Columns data={s?.expiry ?? []} color="multi" /></ChartCard>
      </div>
    </section>
  );
}
