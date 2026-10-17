// Sisyphus motif: a rising ink curve with a gold ball resting on it (new-ds/components/HillMark).
// Ball centres are precomputed so the ball touches the curve along its normal.
export function HillMark({ variant = "hero", className }: { variant?: "hero" | "mini"; className?: string }) {
  if (variant === "mini") {
    return <svg viewBox="0 0 220 56" className={className} aria-hidden="true">
      <path d="M2 50 C 90 50 150 36 218 8" className="sy-s-ink" strokeWidth="3" strokeLinecap="round"/>
      <circle cx="147.2" cy="21.6" r="9" className="sy-f-gold"/>
    </svg>
  }
  return <svg viewBox="0 0 2000 340" className={className} role="img" aria-label="A gold ball resting on a long rising curve">
    <path d="M0 330 C 900 330 1500 268 2000 80" className="sy-s-ink" strokeWidth="5" strokeLinecap="round"/>
    <circle cx="1427.6" cy="164.6" r="66" className="sy-f-gold"/>
  </svg>
}
