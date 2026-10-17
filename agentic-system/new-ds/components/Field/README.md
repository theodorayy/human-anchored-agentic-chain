# Field
A labelled single-line input whose states are told in gold and in words, never in red.

- The consumer provides a visible label (`sy-field__label`, `ui-label`), the placeholder and the value. The label always stays above the input.
- Active and error both use a 1.5px `gold` outline; the error adds a `gold-strong` hint beneath ("Required"), so state never depends on colour alone.
- A field the assistant has filled shows a `gold` check badge on the right; a field only the person can complete shows `surface-wash` and the placeholder "Waiting for you".
- Placeholders use `ink-faint`, which is decorative (1.9:1): never put the only instruction there, put it in the label.
- Do not use `paper-alert` red for validation.
