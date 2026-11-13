# Sisyphus FreeID Form Filling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sisyphus receives a FreeID release, keeps the values encrypted and out of the model, logs and screenshots, and types them into NYC Fibre's new plain form via placeholders, including the raw credential in an attestation field.

**Architecture:** A per-task encrypted vault in the control-plane store holds released values keyed by placeholder. The model only handles placeholders; the browser executor resolves them at `insertText` time, tags filled fields, masks them before screenshots, and redacts vault values from observation text. Sisyphus gets its own FreeID release flow (OIDC + JWE userinfo), reusing NYC Fibre's verifier.

**Tech Stack:** Next.js 16 + eve 0.53 (agentic-system), Playwright, `node:test` via `tsx`, jose 6; NYC Fibre static page + Vercel functions (jose 5, `node --test`); FreeID NestJS auth-server.

**Spec:** `docs/superpowers/specs/2026-11-12-sisyphus-freeid-form-filling-design.md`

## Global Constraints

- No FreeID app (TestFlight) change. FreeID server change is client registration only.
- No real value in: model input/output, eve history, control-plane store outside the vault ciphertext, logs (`console.*`), audit (`detail`, `typedText`, `actionDetail`), run `observation`, `pageTitle`, `reason`, screenshots.
- No explanatory, reassurance or "verified by" copy in NYC Fibre or Sisyphus. Functional labels only.
- British English in code, comments and labels.
- Vault lifetime: until task deleted, mandate revoked, or mandate `expiresAt`, whichever first.
- Release accepted only if `sha256(issuer + "\0" + id_token.sub)` equals the logged-in `principal.id`.
- Node 24 for agentic-system (`export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`).
- Commit FreeID changes to `main` in `/Users/ray/Documents/projects/2026.nosync/free-identity-passport-wt` (push `HEAD:main`). HAC commits on the current HAC branch. Vercel only with `--scope emmanuel-rs-projects-695f4769`. Never `git stash`.

## Review Focus

1. A page that echoes a typed value back as plain text (order summary): the value must not appear in the observation or the screenshot. → Task 4 test `echoed values are redacted from text and screenshot`.
2. The model passes a literal value it guessed, or an unknown placeholder like `{passport.middle_name}`: unknown placeholders are rejected with an error naming only the token; literal text types as-is (not our concern). → Task 4 test `unknown placeholders are rejected`.
3. A release from a different FreeID account than the signed-in one: discarded, vault not created. → Task 3 test `release from another account is rejected`.
4. The task is deleted or revoked while values are stored: vault gone, later typing of a placeholder fails. → Task 2 test `vault is deleted with the task and on revocation`.
5. A placeholder inside other text (`{passport.given_name} {passport.family_name}`) and case variants on the page (`SMITH` vs `Smith`): both resolved/redacted. → Task 2 tests `resolves several placeholders in one string`, `redacts case-insensitive and whitespace variants`.

---

### Task 1: FreeID server lets Sisyphus request a release

**Files:**
- Modify: `/Users/ray/Documents/projects/2026.nosync/free-identity-passport-wt/apps/auth-server/src/modules/oidc/services/client.service.ts` (entry `hac-agentic-system-web`, ~line 39)

**Interfaces:**
- Produces: client `hac-agentic-system-web` with `allowedScopes: ['openid','profile','email','passport','passport:name','passport:birthdate','passport:nationality','passport:expiry','passport:number_masked','licence','licence:address']` and `redirectUris` adding `https://hac-agentic-system.vercel.app/api/freeid/callback`.

- [ ] **Step 1:** Add the scopes and redirect URI above to the `hac-agentic-system-web` entry. Do not touch other clients.
- [ ] **Step 2:** Run `cd apps/auth-server && pnpm exec tsc --noEmit -p tsconfig.json && pnpm exec jest src/modules/oidc` — expected: no type errors; oidc tests pass (if the known `@peculiar/asn1-schema` duplicate breaks App Attest suites, note it and run with `/tmp/fm-spike/jest-single-peculiar.json` as before).
- [ ] **Step 3:** Commit on `main` in the FreeID worktree: `feat(oidc): let Sisyphus request passport and licence-address releases`; push `HEAD:main`. Deploy is Task 7.

### Task 2: Vault (encrypt, placeholders, resolve, redact, expire)

**Files:**
- Create: `agentic-system/lib/hac/vault.ts`
- Modify: `agentic-system/lib/hac/types.ts` (add `Vault`, `State.vaults?: Vault[]`), `agentic-system/lib/hac/control-plane.ts` (`revokeMandate`, `deleteTask` call `dropVault`)
- Test: `agentic-system/tests/vault.test.ts`

**Interfaces:**
- Produces:
  - `type Vault = { mandateId: string; principalId: string; values: Record<string, string /* base64 iv|ct|tag */>; createdAt: string; expiresAt: string }`
  - `placeholdersFromRelease(release: { fields: Record<string,string>; address: { value: Record<string,string> } | null }, credential: string): Record<string, string>` — keys (no braces): `passport.given_name`, `passport.family_name`, `passport.full_name`, `passport.birthdate` (ISO), `passport.birthdate.mdy` (`MM/DD/YYYY`), `passport.nationality`, `passport.passport_expiry`, `passport.document_number_masked`, `licence.street_address`, `licence.locality`, `licence.region`, `licence.postal_code`, `licence.address` (one line, `street, locality, region postal_code`), `attestation`. Names title-cased (`SMITH` → `Smith`, `ANNE-MARIE` → `Anne-Marie`). Absent source fields produce no key.
  - `storeVault(state: State, mandate: Mandate, values: Record<string,string>): void` (replaces any existing vault for the mandate; `expiresAt = mandate.expiresAt`)
  - `vaultKeys(state: State, mandateId: string): string[]`
  - `openVault(state: State, mandateId: string, now?: number): Record<string,string> | null` (null if missing, expired, or mandate revoked)
  - `resolvePlaceholders(text: string, values: Record<string,string>): string` — throws `Error("Unknown placeholder {name}")` for `{a.b}` tokens not in `values`; token regex `/\{([a-z]+(?:\.[a-z_]+)+)\}/g`.
  - `redact(text: string, values: Record<string,string>): string` — replaces each value (longest first, case-insensitive, any run of whitespace in the value matches `\s+`) with `{key}`; skips values shorter than 3 characters.
  - `dropVault(state: State, mandateId: string): void`
- Key: `HAC_VAULT_KEY` (64 hex chars) → AES-256-GCM, random 12-byte IV per value. Throw `Error("HAC_VAULT_KEY is not configured")` if absent.

- [ ] **Step 1: Write failing tests** in `tests/vault.test.ts` (set `HAC_VAULT_KEY` and a temp `HAC_DATA_DIR` at the top, like `control-plane.test.ts`):
  - `placeholders cover passport, licence and attestation`: from `{ fields: { given_name: "ANNE-MARIE", family_name: "SMITH", birthdate: "1990-02-03", nationality: "SGP", passport_expiry: "2031-01-01", document_number_masked: "*****123" }, address: { value: { street_address: "2 West Loop Rd Apt 14C", locality: "New York", region: "NY", postal_code: "10044" } } }`, credential `"eyJ.x~d~kb"` → `passport.given_name === "Anne-Marie"`, `passport.full_name === "Anne-Marie Smith"`, `passport.birthdate.mdy === "02/03/1990"`, `licence.address === "2 West Loop Rd Apt 14C, New York, NY 10044"`, `attestation === "eyJ.x~d~kb"`.
  - `no licence means no licence keys`: `address: null` → no key starts with `licence.`.
  - `stored values are ciphertext`: after `storeVault`, `JSON.stringify(state.vaults)` does not contain `"SMITH"`, `"Smith"` or `"1990-02-03"`; `openVault` returns the originals.
  - `resolves several placeholders in one string`: `resolvePlaceholders("{passport.given_name} {passport.family_name}", v) === "Anne-Marie Smith"`.
  - `unknown placeholders are rejected`: throws `/Unknown placeholder \{passport.middle_name\}/` and the message does not contain any value.
  - `redacts case-insensitive and whitespace variants`: `redact("Name: SMITH, ANNE-MARIE\n2 West  Loop Rd Apt 14C", v)` contains no `SMITH`/`Smith`/`West`; contains `{passport.family_name}`.
  - `vault is deleted with the task and on revocation`: `createMandate` + `storeVault`, then `revokeMandate` → `openVault` null and `vaultKeys` empty; same for `deleteTask` (bind an eve session first as in existing tests), and for `expiresAt` in the past.
- [ ] **Step 2:** Run `pnpm exec tsx --test tests/vault.test.ts` — expected FAIL (module missing).
- [ ] **Step 3:** Implement `lib/hac/vault.ts` with the signatures above; add the types; call `dropVault` inside the existing `revokeMandate` and `deleteTask` transactions; `openVault` also drops expired vaults.
- [ ] **Step 4:** Run `pnpm test` — expected all pass (23 existing + new).
- [ ] **Step 5:** Commit `feat(sisyphus): encrypted per-task vault with placeholders and redaction`.

### Task 3: Sisyphus FreeID release flow

**Files:**
- Create: `agentic-system/lib/freeid/verify-release.js` (verbatim copy of `nyc-fibre/api/_verify.js`, plus return field `presentation` = the decrypted SD-JWT presentation string), `agentic-system/lib/freeid/verify-release.d.ts`, `agentic-system/lib/hac/identity.ts`
- Modify: `agentic-system/lib/hac/sealed-cookie.ts` (purpose union adds `"freeid"`), `agentic-system/app/api/[...path]/route.ts` (routes), `agentic-system/app/.well-known/jwks.json/route.ts` (publish enc key), `agentic-system/lib/hac/types.ts` (`State.identityRequests?: { mandateId: string; principalId: string; requestedAt: string }[]`), `agentic-system/.env.example`
- Test: `agentic-system/tests/identity.test.ts`, fixtures copied from `nyc-fibre/test/fixtures.js` to `agentic-system/tests/fixtures/freeid.js`

**Interfaces:**
- Consumes: Task 2 `placeholdersFromRelease`, `storeVault`.
- Produces:
  - `requestIdentity(state: State, principalId: string, mandateId: string): { status: "ready"; placeholders: string[] } | { status: "pending" }` — creates/keeps a pending request; returns ready with `vaultKeys` if a vault exists.
  - `beginRelease(principal: Principal, mandateId: string): Promise<Response>` — 302 to FreeID authorise with `client_id = OIDC_CLIENT_ID`, scopes = Task 1 list minus `profile email`, `redirect_uri = ${appUrl()}/api/freeid/callback`, PKCE, `state`, `nonce`; sealed cookie `hac_freeid` (purpose `"freeid"`, 600 s) holding `{ state, nonce, verifier, mandateId, principalId }`.
  - `finishRelease(request: Request): Promise<Response>` — token exchange with the same `private_key_jwt` as `finishLogin` (factor the assertion into a shared `clientAssertion(tokenEndpoint)` in `lib/hac/oidc.ts`); verify `id_token` (issuer, audience, nonce, `amr` includes `nansen`); require principal-id match (constraint above); fetch userinfo (`application/jwt`), `verifyRelease({ jwe, encPrivateJwk: OIDC_ENC_PRIVATE_JWK, issuerJwks, issuer, clientId, nonce })`; `storeVault(placeholdersFromRelease(release, release.presentation))`; clear the pending request; 302 to `${appUrl()}/workspace?identity=ready`. Any failure: 302 to `${appUrl()}/workspace?identity=failed`, log only the failure message (never values).
  - Routes: `GET identity/start?mandate=<uuid>` (requires principal + owned mandate + pending request) → `beginRelease`; `GET freeid/callback` → `finishRelease`. Note the Next route is `/api/freeid/callback`.
  - Snapshot: `/api/state` mandates gain `identity: "none" | "pending" | "ready"` (computed, no values, no keys list).
  - JWKS adds `{ kty, crv, x, y, kid: "hac-rp-enc", use: "enc", alg: "ECDH-ES" }` from `OIDC_ENC_PRIVATE_JWK`.

- [ ] **Step 1: Write failing tests** in `tests/identity.test.ts` using a stand-in FreeID (local HTTP server serving discovery, token, JWKS, userinfo; build the JWE with the copied fixtures as `nyc-fibre/test/flow.test.js` does):
  - `a verified release fills the vault and ends the request`: `finishRelease` with valid state → 302 `?identity=ready`; `vaultKeys` includes `passport.family_name` and `attestation`; pending request cleared.
  - `release from another account is rejected`: id_token `sub` different from the principal → 302 `?identity=failed`; no vault.
  - `a tampered or mismatched-nonce release is rejected`: → `?identity=failed`; no vault.
  - `logs never contain values`: capture `console.error`/`console.log` during the failure tests; joined output contains none of the fixture's name/birthdate/address strings.
  - `jwks publishes the encryption key without private parts`: JWKS route body has a key with `use: "enc"` and no `d`.
- [ ] **Step 2:** Run `pnpm exec tsx --test tests/identity.test.ts` — expected FAIL.
- [ ] **Step 3:** Implement the files above. Add `OIDC_ENC_PRIVATE_JWK=` and `HAC_VAULT_KEY=` to `.env.example`.
- [ ] **Step 4:** Run `pnpm test && pnpm typecheck && pnpm lint` — expected pass.
- [ ] **Step 5:** Commit `feat(sisyphus): request a FreeID release into the task vault`.

### Task 4: Executor resolves placeholders, masks and redacts

**Files:**
- Modify: `agentic-system/lib/hac/browser.ts`, `agentic-system/lib/hac/control-plane.ts` (`completeExecution` stores redacted values; `actionLabel`/`typedText` unchanged so they keep placeholders)
- Test: `agentic-system/tests/browser.test.ts`

**Interfaces:**
- Consumes: Task 2 `openVault`, `resolvePlaceholders`, `redact`.
- Produces: `maskForScreenshot(page: Page, values: Record<string,string>): Promise<void>` (exported). For `type`: `const text = resolvePlaceholders(action.text, values ?? {})` immediately before `page.keyboard.insertText(text)`; if the action text contains a placeholder, set `data-hac-filled="1"` on `document.activeElement` (and its closest `input, textarea, select`). Before every `page.screenshot`: add a style tag (id `hac-mask`) with `[data-hac-filled] { -webkit-text-security: disc !important; color: transparent !important; text-shadow: 0 0 0 #888 !important; }` and wrap every text node containing a vault value (case-insensitive) in a `<span data-hac-filled style="background:#888;color:#888">`; then screenshot. Observation, `pageTitle` and any thrown error message pass through `redact(…, values)` before `completeExecution`.

- [ ] **Step 1: Write failing tests** in `tests/browser.test.ts` (fixture page: a form with `<input id="name">`, `<input id="dob">`, a submit button that writes `Thanks, ${name}` into `<p id="summary">`; vault stored via Task 2 for the mandate):
  - `typing a placeholder enters the real value`: after click on `#name` and `type "{passport.full_name}"`, `page.inputValue("#name")` (read via a test-only hook or by re-reading the DOM in the test through Playwright) equals `"Anne-Marie Smith"`; the run's audit `typedText` is `"{passport.full_name}"`.
  - `echoed values are redacted from text and screenshot`: after submit, the run `observation` contains `{passport.full_name}` and not `Smith`; and after `maskForScreenshot(page, values)` (exported from `browser.ts`, the function the executor calls before every screenshot) `page.evaluate` finds no text node containing `smith` (case-insensitive) outside an element with `data-hac-filled`, and `#name` has `data-hac-filled`.
  - `unknown placeholders are rejected`: `type "{passport.middle_name}"` → run `failed`, `reason` mentions `{passport.middle_name}` and no value.
  - `no vault means placeholders fail`: revoke the mandate's vault, `type "{passport.full_name}"` → `failed`.
- [ ] **Step 2:** Run `pnpm exec tsx --test tests/browser.test.ts` — expected FAIL.
- [ ] **Step 3:** Implement in `browser.ts`; read the vault inside the existing authority check transaction for the run's mandate.
- [ ] **Step 4:** Run `pnpm test` — expected pass.
- [ ] **Step 5:** Commit `feat(sisyphus): type vault placeholders, mask filled fields, redact page text`.

### Task 5: Agent tool, instructions and Task details

**Files:**
- Create: `agentic-system/agent/tools/request_identity.ts`
- Modify: `agentic-system/agent/instructions.md`, `agentic-system/agent/subagents/browser_worker/instructions.md`, `agentic-system/agent/subagents/browser_worker/tools/browser.ts` (describe placeholders in `text`), `agentic-system/components/control-room.tsx`, `agentic-system/lib/hac/types.ts` (`Mandate.identity?` in snapshot type)
- Test: `agentic-system/tests/control-plane.test.ts` (tool logic via `requestIdentity`)

**Interfaces:**
- Consumes: Task 3 `requestIdentity`, snapshot `mandate.identity`, route `/api/identity/start?mandate=`.
- Produces: tool `request_identity` (input `{}`) → `{ status: "pending" }` or `{ status: "ready", placeholders: ["{passport.given_name}", …] }` (braced).

- [ ] **Step 1: Failing test** `request_identity is pending until a release arrives, then lists placeholders only`: `requestIdentity` → pending; after `storeVault` → ready with braced keys; serialised output contains no stored value.
- [ ] **Step 2:** Run `pnpm test` — FAIL.
- [ ] **Step 3:** Implement the tool (bind via `state.eveSessions` exactly like `inspect_mandate`). Task details: when the current mandate's `identity === "pending"`, show a section with eyebrow `Identity` and a button `Verify with FreeID` linking to `/api/identity/start?mandate=<id>` (`target="_blank"`). When `?identity=ready` is on the URL or the snapshot flips pending → ready, send a continuation: `My FreeID details are ready. Call request_identity again and continue the task.` (`?identity=failed`: show `FreeID verification failed. Try again.` in the same section.) No other copy.
- [ ] **Step 4:** Instructions. Root, add: "For identity details on a website without FreeID, call request_identity. If it returns pending, tell the human to choose Verify with FreeID in Task details, then wait. Pass only placeholders such as {passport.family_name} to the worker, never values, and never ask the human to type identity details. For an attestation or identity proof field, use {attestation}. Use {passport.birthdate.mdy} where a form wants MM/DD/YYYY. NYC Fibre: use its plain form, not its FreeID button." Worker, add: "Text may contain placeholders such as {passport.family_name}; type them exactly as given; the system fills them in. Filled values are hidden from you; never try to read, copy or describe them." Remove the old instruction to choose "Verify with FreeID" at NYC Fibre (broker portal keeps its FreeID step).
- [ ] **Step 5:** Run `pnpm test && pnpm typecheck && pnpm lint` — pass. Commit `feat(sisyphus): request_identity tool and Task details FreeID step`.

### Task 6: NYC Fibre plain form with attestation field

**Files:**
- Modify: `nyc-fibre/index.html`
- Test: `nyc-fibre/test/plain-form.test.js` (Playwright via `npx playwright` is not a dependency there; use `node --test` with `jsdom`-free string checks plus a manual check in Task 7)

**Interfaces:**
- Produces: DOM ids the agent and tests rely on: step 1 `#manual-address` (button `Enter address`), form `#address-form` with `#street`, `#unit`, `#city`, `#state`, `#zip` and submit `Check availability`; identity step option `#enter-details` (`Enter details`), form `#details-form` with `#given-name`, `#family-name`, `#dob` (`type="text"`, placeholder `MM/DD/YYYY`), `#attestation` (textarea, label `Identity attestation`), submit `Continue`.

- [ ] **Step 1: Failing test** `plain form fields exist with labels and no explanatory copy`: read `index.html`; assert each id above exists, `label[for=attestation]` text is exactly `Identity attestation`, and the new markup adds no `<p>` inside `#address-form` or `#details-form`.
- [ ] **Step 2:** Run `npm test` in `nyc-fibre` — FAIL.
- [ ] **Step 3:** Implement. Address form submission completes step 1 with the typed address (shown in the step summary as typed; it is the user's own entry) and continues to plan. Details form completes identity and enables `Create my account`. The attestation is kept only in page memory: not sent to any endpoint, not shown, not logged. (Plan call: the spec said "same encrypted cookie as the order state", but the plain path has no server step, so page memory is the simpler equivalent.) FreeID buttons unchanged. Remove the step-3 hint sentence about name and date of birth only if it now contradicts the plain path (it does: delete it).
- [ ] **Step 4:** Run `npm test` — pass. Commit `feat(nyc-fibre): plain address and details forms with an attestation field`.

### Task 7: Configure, deploy, live check

- [ ] **Step 1:** Deploy FreeID server: from the FreeID worktree, `fly deploy -a free-identity-auth` (as previous server deploys). Verify `curl -s https://api.free-id.org/.well-known/openid-configuration` is 200.
- [ ] **Step 2:** Deploy NYC Fibre: `cd nyc-fibre && vercel deploy --prod --yes --scope emmanuel-rs-projects-695f4769`. Open https://nyc-fibre.vercel.app and confirm `Enter address` and `Enter details` appear.
- [ ] **Step 3:** Sisyphus secrets, without printing them: generate a P-256 JWK and 32-byte hex key in Node and pipe `OIDC_ENC_PRIVATE_JWK=…` and `HAC_VAULT_KEY=…` into `fly secrets import -a hac-agentic-runtime --stage`. (If the permission is denied, give Ray the one-line command.)
- [ ] **Step 4:** `cd agentic-system && fly deploy -a hac-agentic-runtime --remote-only` (Vercel rewrites every path to Fly, so this deploys the UI too, including the earlier stall fix). Then `vercel deploy --prod --yes --scope emmanuel-rs-projects-695f4769` to keep Vercel's build in step.
- [ ] **Step 5:** Verify `curl -s https://hac-agentic-system.vercel.app/.well-known/jwks.json` lists `hac-rp-enc` with no `d`. Ask Ray to run "Set up home internet" with the plain-form path and report; check Fly logs contain no values.
- [ ] **Step 6:** Append the worklog entry.
