// Original illustration: a hanging "Lost & Found" sign for the home banner.
// Pure SVG (no external image), transparent background so it sits on both
// themes, decorative only (the banner heading carries the meaning).
export function HeroSign({ lines }: { lines: string[] }) {
  const lineHeight = 46;
  const startY = 196 - ((lines.length - 1) * lineHeight) / 2;
  return (
    <svg viewBox="-10 0 340 320" overflow="visible" className="hero-sign h-auto w-full max-w-[320px]" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="sign-face" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f26a3d" />
          <stop offset="1" stopColor="#e2552a" />
        </linearGradient>
        <filter id="sign-shadow" x="-40%" y="-40%" width="180%" height="200%">
          <feDropShadow dx="0" dy="10" stdDeviation="10" floodColor="#000" floodOpacity="0.28" />
        </filter>
      </defs>

      {/* Nail */}
      <circle cx="160" cy="26" r="11" fill="#c9ced6" />
      <circle cx="157" cy="23" r="4" fill="#ffffff" opacity="0.85" />

      <g className="hero-sign-swing">
        {/* String */}
        <path d="M74 126 L160 28 L246 126" fill="none" stroke="#3a4250" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />

        {/* Board */}
        <g filter="url(#sign-shadow)">
          <rect x="22" y="112" width="276" height="168" rx="22" fill="#ffffff" />
          <rect x="30" y="120" width="260" height="152" rx="16" fill="url(#sign-face)" />
        </g>

        {/* Eyelets */}
        <circle cx="74" cy="134" r="8" fill="#3a4250" />
        <circle cx="246" cy="134" r="8" fill="#3a4250" />

        {/* Text */}
        {lines.map((line, i) => (
          <text
            key={line}
            x="160"
            y={startY + i * lineHeight}
            textAnchor="middle"
            dominantBaseline="middle"
            fill="#ffffff"
            fontSize={lines.length > 2 ? 34 : 40}
            fontWeight="800"
            letterSpacing="2"
            style={{ fontFamily: "var(--font-geist-sans), 'Noto Sans Devanagari', system-ui, sans-serif" }}
          >
            {line}
          </text>
        ))}
      </g>
    </svg>
  );
}
