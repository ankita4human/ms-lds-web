/** The sign-in mascot: follows the cursor and your typing, covers its eyes while you type the password, peeks while the password is shown. */
export type MonkeyMood = 'idle' | 'happy' | 'sad';

export default function LoginMonkey({ cover, peek, mood, look }: { cover: boolean; peek: boolean; mood: MonkeyMood; look: { x: number; y: number } }) {
  const px = peek ? -2 : look.x, py = peek ? 3.2 : look.y;
  const pupil = { transform: `translate(${px}px, ${py}px)` };
  const happy = mood === 'happy';
  return (
    <div className="mk-wrap" aria-hidden="true">
      <svg className={`mk ${cover ? 'cover' : ''} ${peek ? 'peek' : ''} ${mood}`} viewBox="0 0 160 160" role="img">
        <defs>
          <clipPath id="mkc"><circle cx="80" cy="80" r="78" /></clipPath>
          <radialGradient id="mkbg" cx=".5" cy=".25" r=".95"><stop offset="0" stopColor="#e3f1ff" /><stop offset="1" stopColor="#8fbcf7" /></radialGradient>
          <linearGradient id="mkfur" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#b57a43" /><stop offset="1" stopColor="#8f5a2e" /></linearGradient>
        </defs>
        <g clipPath="url(#mkc)">
          <rect width="160" height="160" fill="url(#mkbg)" />
          <ellipse cx="80" cy="172" rx="64" ry="46" fill="url(#mkfur)" />
          <g className="mk-head">
            <circle cx="27" cy="84" r="17" fill="#9a6334" /><circle cx="27" cy="84" r="9" fill="#f0c9a0" />
            <circle cx="133" cy="84" r="17" fill="#9a6334" /><circle cx="133" cy="84" r="9" fill="#f0c9a0" />
            <circle cx="80" cy="80" r="54" fill="url(#mkfur)" />
            <path d="M80 58 C60 40 30 62 40 90 C44 114 62 130 80 130 C98 130 116 114 120 90 C130 62 100 40 80 58Z" fill="#f6dcb9" />
            {/* eyes */}
            {[62, 98].map(cx => (
              <g key={cx}>
                <g className="mk-eye" style={{ opacity: happy ? 0 : 1 }}>
                  <circle cx={cx} cy="80" r="11.5" fill="#fff" stroke="rgba(60,30,10,.25)" strokeWidth="1" />
                  <g className="mk-pupil" style={pupil}><circle cx={cx} cy="80" r="5.6" fill="#2b1b10" /><circle cx={cx + 1.8} cy="77.8" r="1.8" fill="#fff" /></g>
                </g>
                <path d={`M${cx - 8} 81 Q${cx} 71 ${cx + 8} 81`} fill="none" stroke="#3b2412" strokeWidth="3.2" strokeLinecap="round" style={{ opacity: happy ? 1 : 0 }} />
              </g>
            ))}
            {/* brows */}
            <path d="M51 66 Q62 60 73 66" fill="none" stroke="#6b3d1c" strokeWidth="3" strokeLinecap="round" className="mk-brow bl" />
            <path d="M87 66 Q98 60 109 66" fill="none" stroke="#6b3d1c" strokeWidth="3" strokeLinecap="round" className="mk-brow br" />
            {/* nose, mouth */}
            <ellipse cx="80" cy="100" rx="9" ry="6.2" fill="#e0b184" /><circle cx="76.5" cy="100" r="1.5" fill="#7a4a24" /><circle cx="83.5" cy="100" r="1.5" fill="#7a4a24" />
            <path className="mk-mouth m-idle" d="M67 110 Q80 119 93 110" fill="none" stroke="#6b3d1c" strokeWidth="3" strokeLinecap="round" />
            <path className="mk-mouth m-happy" d="M64 108 Q80 128 96 108 Z" fill="#8a2f2f" stroke="#6b3d1c" strokeWidth="2.5" strokeLinejoin="round" />
            <path className="mk-mouth m-sad" d="M68 116 Q80 104 92 116" fill="none" stroke="#6b3d1c" strokeWidth="3" strokeLinecap="round" />
            <circle cx="50" cy="100" r="6" fill="#ff8f8f" opacity=".28" /><circle cx="110" cy="100" r="6" fill="#ff8f8f" opacity=".28" />
            <path className="mk-tear" d="M104 92 q-4 7 0 10 q4 -3 0 -10z" fill="#7cc4ff" />
          </g>
          {/* hands */}
          {[{ c: 'hl', x: 46 }, { c: 'hr', x: 114 }].map(h => (
            <g key={h.c} className={`mk-hand ${h.c}`}>
              <g transform={`translate(${h.x} 176)`}>
                <rect x="-12" y="4" width="24" height="150" rx="11" fill="url(#mkfur)" />
                <ellipse rx="22" ry="18" fill="url(#mkfur)" />
                {[-13, -4.5, 4.5, 13].map(f => <rect key={f} x={f - 4} y="-30" width="8" height="20" rx="4" fill="#a8703b" stroke="#7a4a24" strokeWidth="1.2" />)}
                <ellipse cx="0" cy="-2" rx="14" ry="9" fill="#f0c9a0" opacity=".55" />
              </g>
            </g>))}
        </g>
        <circle cx="80" cy="80" r="78" fill="none" stroke="rgba(255,255,255,.85)" strokeWidth="3" />
      </svg>
    </div>
  );
}
