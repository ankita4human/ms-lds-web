import { useEffect } from 'react';
import { useViewPrefs, viewCss } from '../viewPrefs';

/** Writes the View-tab preferences (font, hidden grid columns) into one <style> element. Rendered once in the shell. */
export default function ViewStyle() {
  const p = useViewPrefs();
  useEffect(() => {
    let el = document.getElementById('pl-view-style') as HTMLStyleElement | null;
    if (!el) { el = document.createElement('style'); el.id = 'pl-view-style'; document.head.appendChild(el); }
    el.textContent = viewCss(p);
  }, [p]);
  return null;
}
