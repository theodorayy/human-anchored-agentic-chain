# ProgressSteps
Equal pill segments filling in `gold`, with the same position written below as "Step 2 of 3".

- Segments are 4px high, 8px apart, `radius-pill`; done is `gold`, remaining is `track`.
- Always print the label (`ink-muted`, 12px): the fill alone is a colour-only signal.
- The consumer provides the total and the current step; three to five segments.
