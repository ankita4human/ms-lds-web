import { useIsFetching, useIsMutating } from '@tanstack/react-query';
import { tr } from '../i18n';

/** Thin animated bar at the very top of the window while any request is running. */
export function TopProgress() {
  const busy = useIsFetching() + useIsMutating() > 0;
  return <div className={`top-progress ${busy ? 'on' : ''}`} role="progressbar" aria-hidden={!busy} aria-label={tr('Loading')}><span /></div>;
}

/** Branded loader: logo inside a spinning gradient ring, with a message and bouncing dots. */
export function PageLoader({ label = 'Loading...', compact = false }: { label?: string; compact?: boolean }) {
  return (
    <div className={`page-loader ${compact ? 'compact' : ''}`} role="status" aria-live="polite">
      <div className="ring-wrap">
        <div className="ring" />
        <div className="ring ring-2" />
        <img src="/logo-lds.png" alt="" />
      </div>
      <div className="loader-label">{label}<span className="dots-anim"><i /><i /><i /></span></div>
    </div>
  );
}

/** Shimmering placeholder rows for tables and lists. */
export function SkeletonRows({ rows = 8, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} className="skel-row">
          {Array.from({ length: cols }).map((__, c) => <td key={c}><span className="skel" style={{ width: `${55 + ((r * 7 + c * 13) % 40)}%` }} /></td>)}
        </tr>
      ))}
    </>
  );
}

export const Spinner = () => <span className="spinner" aria-hidden="true" />;
