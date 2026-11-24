import type { ReactNode } from 'react';

/** Gradient banner shown at the top of the Options pages. */
export default function PageHero({ icon, title, sub, chips }: { icon: ReactNode; title: string; sub: string; chips?: { n: ReactNode; label: string }[] }) {
  return (
    <div className="um-hero">
      <div className="um-hero-ico">{icon}</div>
      <div className="um-hero-txt"><h2>{title}</h2><p>{sub}</p></div>
      {chips && <div className="um-chips">{chips.map(c => <span key={c.label} className="um-chip"><b>{c.n}</b>{c.label}</span>)}</div>}
    </div>
  );
}
