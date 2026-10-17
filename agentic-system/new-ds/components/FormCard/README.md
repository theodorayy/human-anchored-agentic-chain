# FormCard
The card that holds a form: title, stacked fields, one primary button, optional footer link.

- Build with `sy-card` (14px radius, `shadow-card`, 24px padding, 16px gaps); the title uses `ui-title`. The consumer provides the fields and the single action.
- Wrap in `sy-window` with the three-dot `track` bar when the card stands for "a website" in a diagram.
- Tilt a card ±3° with `sy-tilt-l` / `sy-tilt-r` (which swap in `shadow-float`) only in collages that show the pile of forms people face, never in working UI.
- One card, one task: no more than four fields.
