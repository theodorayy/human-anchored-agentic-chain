// Sisyphus check badge: an ink check on a gold disc (new-ds bundle.css `.sy-check`).
export function Check({ size = "md", label }: { size?: "sm" | "md" | "lg"; label?: string }) {
  return <span className={`sy-check${size === "md" ? "" : ` sy-check--${size}`}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
    <svg viewBox="0 0 10 10"><path d="M2 5.2 4.1 7.2 8 2.8"/></svg>
  </span>
}
