# VerifiedCard
The receipt of trust: what an organisation receives, field by field, each row checked, with the words "Shared with your approval".

- Header check badge + "Verified KYC data"; rows pair a caption (`ui-caption`) with a value (`ui-body`) and a `gold` check; the footer is a `surface-subtle` pill.
- Draw dashed `gold` connectors (`sy-link`) from the card to recipient `IconTile`s (without ID badges).
- The consumer provides only fields that were verified and approved; an unverified field is omitted, not shown unchecked.
