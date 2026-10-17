# Button
The one-per-view action control: an ink block button for the main step, a gold pill for approving what the assistant did, an outline pill for the quieter alternative.

- Use `sy-btn sy-btn--primary` (full width inside cards with `sy-btn--block`) for the single forward action: "Create account", "Continue". One per card.
- Use `sy-btn--pill sy-btn--gold` for "Approve" and `sy-btn--pill sy-btn--outline` for "Edit" side by side; never two gold pills together.
- Disabled buttons stay in view with the `disabled` fill and sit under a field that says what they are waiting for.
- Labels are one or two words, sentence case, verb first. The consumer provides the label and the click handler.
- Focus ring is a solid 2px `ink` outline with a 2px offset (17:1 on `surface`).
