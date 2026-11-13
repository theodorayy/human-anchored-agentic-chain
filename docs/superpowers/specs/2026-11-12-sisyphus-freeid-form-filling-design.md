# Sisyphus fills forms with FreeID-verified details, without seeing them

Status: approved in conversation with Ray, 12 Nov 2026
Scope: `agentic-system/` (Sisyphus), `nyc-fibre/`, FreeID server client registration. No FreeID app (TestFlight) change.

## 1. Intent

Websites should not each have to integrate FreeID. Sisyphus becomes the one FreeID relying party: the human releases their verified details to Sisyphus once, and the agent types them into ordinary forms on the human's behalf.

The human's details must not reach the AI model, Sisyphus's logs or audit, or the browser screenshots. Sisyphus's server holds them encrypted and decrypts a value only for the moment it types it. (Ray accepted that the server must hold values at type time, because the browser runs on the server. Typing on the human's own device is out of scope.)

A website can be handed proof that the details are verified: the agent pastes the FreeID credential into an attestation field. NYC Fibre demonstrates this field. It does not verify the credential (Ray: "just prove that there's an attestation field").

## 2. Goals

1. Sisyphus requests a FreeID release (passport fields and the licence address) when the agent first needs a value, and the human approves on their phone with today's app.
2. Released values and the raw credential are stored encrypted per task and deleted when the task ends (task deleted, mandate revoked or expired).
3. The model only ever sees placeholders, e.g. `{passport.family_name}`, `{licence.address}`, `{attestation}`.
4. The browser executor replaces placeholders in a `type` action with real values at execution time.
5. No real value appears in: model inputs/outputs, eve history, the control-plane store (except the encrypted vault), logs, audit (`typedText`, `detail`), run observations, or screenshots.
6. NYC Fibre gets a plain typed signup path next to its existing FreeID button, with an attestation field.

## 3. Non-goals

- Verifying the attestation on NYC Fibre, or Sisyphus wrapping it in its own signed envelope.
- Per-website audience binding signed by the phone (needs a new app build; later).
- Tokenising email and phone. The human gives them in chat as now; the model sees them.
- Any change to the broker portal. There the agent keeps using the portal's own Verify with FreeID button.
- Typing on the human's device (browser extension).

## 4. Anti-goals

- A real value leaking into a screenshot, observation text, audit row or log line.
- The model being able to obtain a value by any tool (e.g. a tool that returns detokenised text, or reading a field back).
- Explanatory, reassurance or "verified by" copy added to NYC Fibre or Sisyphus. Only functional labels. (Standing rule: no filler UI copy.)

## 5. Decided design

### 5.1 FreeID server

- Client `hac-agentic-system-web` (in `apps/auth-server/src/modules/oidc/services/client.service.ts`) gets the scopes NYC Fibre already uses for the passport and the licence address: `passport`, `passport:name`, `passport:birthdate`, `licence`, `licence:address` (builder: mirror NYC Fibre's allowedScopes for these; add nationality/expiry only if the form needs them).
- Redirect URI for the release flow: a new Sisyphus callback (separate from login), e.g. `https://hac-agentic-system.vercel.app/api/freeid/callback`. Registered in the client entry.
- The release reaches Sisyphus the same way it reaches NYC Fibre: JWE-encrypted to the client's encryption key, collected from `/userinfo`. Sisyphus reuses NYC Fibre's verifier logic (`nyc-fibre/api/_verify.js`) adapted to TypeScript: issuer signature, holder key binding, required checks (passive authentication, CSCA chain, App Attest, face match).
- Sisyphus needs a P-256 encryption key published in its JWKS (it already publishes a signing key for `private_key_jwt`).

### 5.2 Sisyphus: requesting the release

- New root-agent tool `request_identity` (no inputs). It starts a FreeID release for the current task and returns the list of available placeholders once released, or `pending` with nothing else.
- Task details shows a "Verify with FreeID" button for the pending release. It opens FreeID's authorise URL in a new tab of the human's browser; FreeID's own page shows the real QR (as for NYC Fibre today) and the redirect returns to `/api/freeid/callback`. No Sisyphus-drawn QR and no FreeID server flow change. (My call.)
- The callback requires the release's FreeID `sub` to equal the logged-in Principal's `sub` (same client, so the pairwise `sub` matches); otherwise it is discarded. A forwarded link cannot put someone else's passport in the vault. (My call.)
- When the release is stored, the workspace sends the root agent a continuation message, using the same mechanism as "Approve & continue", so the task resumes without the human typing. (My call.)
- Only one release per task. If one exists, `request_identity` returns the placeholders immediately.

### 5.3 Sisyphus: the vault

- Stored in the control-plane store as one record per task: `{ mandateId, rootSessionId, fields: { [placeholder]: ciphertext }, credential: ciphertext, createdAt, expiresAt }`.
- Encryption: AES-256-GCM with a key derived from a new Fly secret `HAC_VAULT_KEY` (not the HMAC signing key), per-record random IV.
- Placeholders (my call, extend as needed): `passport.given_name`, `passport.family_name`, `passport.full_name`, `passport.birthdate`, `passport.nationality`, `licence.street_address`, `licence.locality`, `licence.region`, `licence.postal_code`, `licence.address` (one line), `attestation` (the raw SD-JWT presentation as received).
- Format variants, because the model cannot reformat values it cannot see (my call): `passport.birthdate` (ISO `YYYY-MM-DD`), `passport.birthdate.mdy` (`MM/DD/YYYY`), and title-cased name placeholders (`passport.given_name`, etc. are title-cased; the original casing is not exposed). Redaction in 5.5 covers every variant.
- The licence is optional (my call). Without a licence in the release, the vault has no `licence.*` keys, `request_identity` lists only what exists, and the agent asks the human for the address in chat (so the model sees that address).
- Deleted when the task is deleted, its mandate is revoked or expires, or after the mandate's expiry time, whichever is first. Pruning runs with the existing state transactions.

### 5.4 Sisyphus: typing

- The browser worker's `type` action text may contain placeholders. Validation accepts `{name}` tokens from the vault's key set; unknown tokens are rejected with an error naming only the token.
- The executor (`lib/hac/browser.ts`) resolves tokens immediately before `page.keyboard.insertText`, from the vault record bound to the run's mandate. The resolved string exists only in that function's scope.
- Audit `typedText` and `actionLabel` keep the placeholder form.
- A typed field is marked for masking: after typing, the executor tags the focused element (e.g. a data attribute) so it is masked in later screenshots.

### 5.5 Sisyphus: keeping values out of what the model and humans see

- Screenshots: before every `page.screenshot`, inject a stylesheet that masks tagged fields (`-webkit-text-security: disc` for inputs; for any other element showing a value, replace with a solid block). Remove nothing from the real page.
- Observation text: after `innerText` is read, replace every occurrence of every vault value (case-insensitive, also whitespace-normalised variants) with its placeholder before it is stored or returned. This also catches pages that echo values back (e.g. an order summary).
- Same replacement applies to `pageTitle` and any error message that could include page text.
- Screenshot masking cannot catch values the site renders into non-input elements without the tag. Builder: also run a value scan over the DOM before the screenshot and mask any text node containing a vault value.

### 5.6 Sisyphus: agent instructions

- Root: for identity details at a site without FreeID, call `request_identity`, then pass placeholders, never values, to the worker; tell the human to scan the code in Task details when `pending`. Never ask the human to type identity details.
- Worker: type placeholders exactly as given; they are filled in by the system. Never try to read back, copy or describe a filled value.
- The attestation field gets `{attestation}`.

### 5.7 NYC Fibre

- Step 1 keeps the FreeID button and gains a plain address form (street, apartment, city, state, ZIP). Choosing it continues to the plan step.
- The identity step gains a plain form: given name, family name, date of birth, and an attestation field (a text area, label "Identity attestation"). Submitting it completes identity and enables Create my account.
- The attestation value is accepted as text and kept in the same encrypted cookie as the rest of the order state; it is not verified, displayed or logged.
- No explanatory copy. Existing FreeID path unchanged.

## 6. Left to the builder

- Exact UI of the QR in Task details (reuse the FreeID release link/QR pattern from NYC Fibre's flow).
- Whether the address in NYC Fibre's plain form is one field or several (several is the default above).
- Test strategy; at minimum: vault encrypt/decrypt and expiry; placeholder validation; executor substitution; redaction of observations; a browser test that types a placeholder into a form and asserts the screenshot and observation contain no value.
- Deployment order: FreeID server client change first, then NYC Fibre, then Sisyphus (Fly secret `HAC_VAULT_KEY` and the encryption JWK before deploy).
