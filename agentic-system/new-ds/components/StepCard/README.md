# StepCard
A numbered stage of a story: a `surface-subtle` container, a "Step n" label, a short title and a white inner panel showing the stage.

- Build with `sy-step` (24px radius, 24px padding); label in `ink-muted`, title in `step-title`, the panel is `sy-step__body` on `surface-raised`.
- Place three side by side with equal widths and a 32px gap to tell a three-beat sequence; the third beat may be a row of `IconTile`s.
- The consumer provides the label, title and the inner illustration. Keep titles under six words.
