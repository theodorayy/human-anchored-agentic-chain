Sisyphus is a trust-first onboarding assistant: you tap a passport once, a visible assistant fills the forms, and organisations receive verified data. Its look is white space, near-black ink and one gold accent, with a ball on a hill as its only illustration.

## Content fundamentals

- Write in British English ("organisations", "rigour"), second person for the product ("fills up forms for you") and "she" for the persona in problem stories. Sentence case everywhere, including buttons and labels.
- Keep statements to one idea and make them short: "Too heavy, she pays. Too light, you pay." Fragments are allowed and usually end in a full stop, including names: "Sisyphus." "Team 421."
- State the problem with a person, then the payoff: "She lands in New York and needs internet. The signup asks for SSN she doesn't have."
- Show repetition in the copy when it is the point: "and on… and on… again and again." Use ellipses and italics for that, nowhere else.
- The assistant speaks in the first person and names the person's role: "Approve before I submit", "Waiting for you", "Your turn". Never hide that the assistant is acting.
- Number steps with digits and a full stop, bold, followed by a light line in the other voice: "**1. Onboard once through tapping.** this is me!"
- Cite a statistic with a superscript number and a footnote in `footnote` style. No emoji, no exclamation marks except in the "this is me! / this is you!" captions.

## Visual foundations

- Ground: `surface` (white) with `ink` text. Use the dark theme once per story for the pivot slide; there `surface` becomes near-black and `gold` becomes pale yellow.
- One accent: `gold`. Spend it on a single phrase per slide (700 weight, 24px and up), the ball, check badges, progress fill, the active field outline and the Approve pill. Never use red for Sisyphus's own states; `paper-alert` red appears only on the paper-form illustration of the old way.
- Small gold text uses `gold-strong`; text on gold fills uses `on-gold`.
- Type: Inter only. Set display copy in weight 300 and flip the key phrase to 700. Use `display-xl`, `display-lg`, `headline`, `lede`, `eyebrow` for slides; `ui-title`, `ui-body`, `ui-label`, `ui-button`, `ui-caption` for product screens. Eyebrows and lead-ins use `ink-subtle`; secondary text uses `ink-muted`.
- Surfaces: cards are `surface-raised` with a 1px `border`, `radius-lg` and `shadow-card`; step containers are `surface-subtle` with `radius-xl` and a white inner panel; inputs and buttons use `radius-md`; chips and approvals use `radius-pill`.
- Spacing runs on a 4px grid (`space-1` to `space-9`): 24px inside cards, 16px between fields, 32px between cards, 64px and up around a slide statement.
- Collages of friction tilt cards ±3° with `shadow-float`; working UI never tilts.
- Motif: `HillMark` — a long rising 5px `ink` curve with a `gold` ball resting on it; a small `border` curve with a `gold` dot bottom-right marks progress and moves right each slide. The title slide may fade `surface` into `gold-tint` at the right edge.
- Motion is not specified. Imagery is flat vector illustration of objects (passport, phone, paper forms); no photographs, no gradients other than the title-slide wash.

## Iconography

- Line icons only: 24px grid, 1.8px stroke in `ink`, round caps and joins, no fill, no emoji. Show them in an `IconTile` (64px, `radius-lg`, 1px `border`) with a caption in `ui-label`.
- The gold "ID" badge on a tile means the organisation asks for identity proof today; recipients of verified data have no badge.
- Check marks are `ink` strokes on a `gold` disc. The tap signal is three arcs in `gold`, `gold-mid`, `gold-soft`.
- Icons are drawn in the deck's style because no icon files were supplied; replace them with the team's originals when available. No logo exists: set the name "Sisyphus" in plain Inter bold.

## Components

- `Statement`, `HillMark` carry the deck. `FormCard`, `Field`, `Button`, `Dropzone`, `ProgressSteps` carry the old way and the new product screens. `StepCard`, `IconTile`, `VerifiedCard`, `ApprovalCard`, `AssistantChip`, `Passport` carry the story. `PaperForm` is for problem slides only.
- Style every control from `bundle.css` classes (`sy-btn`, `sy-field`, `sy-card`, …); never hard-code a hex.

## Accessibility

- Text pairs that hold 4.5:1 in both themes: `ink`, `ink-muted` on `surface`, `surface-raised`, `surface-subtle`; `gold-strong` on `surface`, `surface-subtle`, `gold-tint`; `on-gold` on `gold`.
- Source pairs that miss and stay exact: `gold` on white (3.5:1, large text and graphics only), `ink-subtle` (2.8:1, 28px+ eyebrows only), `ink-faint` placeholders and dashed outlines, hairline `border` on white. Always back a field with a visible label and never rely on the placeholder.
- Status never relies on colour alone: errors add the word "Required", progress adds "Step 2 of 3", every check sits beside the value it confirms.
