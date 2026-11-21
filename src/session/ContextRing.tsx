export function ContextRing({ ratio }: { ratio: number }) {
  const r = 5.5;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - ratio);
  const tone = ratio >= 0.9 ? "var(--error)" : ratio >= 0.75 ? "var(--orange)" : "var(--accent)";
  return (
    <svg className="context-ring" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r={r} fill="none" stroke="var(--border)" strokeWidth="1.8" />
      {ratio > 0 && (
        <circle
          cx="7"
          cy="7"
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth="1.8"
          strokeDasharray={c}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform="rotate(-90 7 7)"
        />
      )}
    </svg>
  );
}
