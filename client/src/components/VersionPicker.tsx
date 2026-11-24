export type Ver = { v1: number; v2: number; v3: number };
export const verText = (v: Ver) => `${v.v1}.${v.v2}.${v.v3}`;
const clamp = (n: number) => Math.max(0, Math.min(999, Number.isFinite(n) ? Math.trunc(n) : 0));
/** true when a is higher than b */
export const isHigher = (a: Ver, b: Ver) => a.v1 !== b.v1 ? a.v1 > b.v1 : a.v2 !== b.v2 ? a.v2 > b.v2 : a.v3 > b.v3;

/**
 * Version choice from the MS LDS manual: minor 0.0.1, middle 0.1.0, major 1.0.0, or any three-digit number (max 999.999.999).
 * New document: the presets are absolute values. Change version: the presets are increments of the current version.
 */
export default function VersionPicker({ value, onChange, current }: { value: Ver; onChange: (v: Ver) => void; current?: Ver }) {
  const presets: { label: string; hint: string; v: Ver }[] = current
    ? [
        { label: 'Minor', hint: 'e.g. small corrections', v: { v1: current.v1, v2: current.v2, v3: current.v3 + 1 } },
        { label: 'Middle', hint: 'also moves other languages', v: { v1: current.v1, v2: current.v2 + 1, v3: 0 } },
        { label: 'Major', hint: 'also moves other languages', v: { v1: current.v1 + 1, v2: 0, v3: 0 } },
      ]
    : [
        { label: 'Minor', hint: 'default', v: { v1: 0, v2: 0, v3: 1 } },
        { label: 'Middle', hint: '', v: { v1: 0, v2: 1, v3: 0 } },
        { label: 'Major', hint: '', v: { v1: 1, v2: 0, v3: 0 } },
      ];
  const set = (k: keyof Ver, n: number) => onChange({ ...value, [k]: clamp(n) });
  const same = (a: Ver, b: Ver) => a.v1 === b.v1 && a.v2 === b.v2 && a.v3 === b.v3;
  const bad = current ? !isHigher(value, current) : value.v1 + value.v2 + value.v3 === 0;
  return (
    <div className="ver-pick">
      <div className="ver-presets">
        {presets.map(p => (
          <button type="button" key={p.label} className={same(p.v, value) ? 'on' : ''} onClick={() => onChange(p.v)} title={p.hint}>
            <b>{verText(p.v)}</b><small>{p.label}</small>
          </button>
        ))}
      </div>
      <div className="ver-custom">
        <span>Custom</span>
        {(['v1', 'v2', 'v3'] as const).map((k, i) => (
          <label key={k}>{i > 0 && <i>.</i>}
            <input type="number" min={0} max={999} value={value[k]} onChange={e => set(k, Number(e.target.value))} aria-label={`Version part ${i + 1}`} />
          </label>
        ))}
        <em className={bad ? 'bad' : ''}>= {verText(value)}</em>
      </div>
      {current && bad && <small className="mh">Choose a version higher than the current {verText(current)}.</small>}
    </div>
  );
}
