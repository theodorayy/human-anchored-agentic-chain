# Verify with FreeID (Phases 1c + 1d) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** NYC Fibre's "Verify with FreeID" receives the user's passport-backed details from their phone, approved by the user, encrypted to NYC Fibre and verifiable as coming from an attested FreeID passport credential; HAC's agent hands the QR to the human and never holds the details.

**Architecture:** At attested issuance the phone sends salted SHA-256 digests of its passport fields (bound by App Attest); FreeID signs an SD-JWT VC issuer JWT over the digests with a now-persistent ES256 key. At release, NYC Fibre runs an OIDC code flow with `passport:*` scopes; FreeID's sign-in page shows a release QR; the phone builds an SD-JWT presentation (selected disclosures + EdDSA key-binding JWT bound to NYC Fibre's client ID and OIDC nonce), encrypts it as a compact JWE (ECDH-ES + A256GCM) to NYC Fibre's published encryption key, and posts it to FreeID, which completes the sign-in with a pairwise `sub` and hands the JWE to NYC Fibre unread via `/userinfo`. HAC lets its browser follow redirects to FreeID's origins but forbids interaction there.

**Tech Stack:** NestJS 11 + TypeORM + Jest (FreeID server), Next.js 16 (FreeID frontend), Expo 53 / RN 0.79 + `@noble/*` (FreeID app), Vercel Node functions + `jose` + `node:test` (NYC Fibre), Next.js + Playwright + `node:test` via `tsx` (HAC).

**Spec:** `docs/superpowers/specs/2026-10-09-verify-with-freeid-design.md` (approved 2026-10-09, with Phase 1b deferred).

## Global Constraints

- No passport data (names, numbers, dates, photos) may reach FreeID's server in any form other than salted digests; FreeID never decrypts or parses the release JWE.
- The HAC agent and its LLMs never receive released values.
- Phase 1b (face match) is deferred: do not release a `face_match` field; issuance continues to record `faceMatch: "not_performed"`.
- Released fields (disclosure names, exactly): `given_name`, `family_name`, `birthdate` (YYYY-MM-DD), `nationality` (ISO 3166-1 alpha-3), `passport_expiry` (YYYY-MM-DD), `document_number_masked`, `document_number`.
- Masking: `document_number_masked` = `"••••••" + last 4 characters of the document number`.
- Scopes: `openid passport` plus per field `passport:name` (→ given_name, family_name), `passport:birthdate`, `passport:nationality`, `passport:expiry`, `passport:number_masked`, `passport:number`.
- SD-JWT: `_sd_alg: "sha-256"`; disclosure = base64url(UTF-8 JSON `[salt, name, value]`), salt = 16 random bytes base64url; digest = base64url(SHA-256(ASCII disclosure)); issuer JWT header `typ: "dc+sd-jwt"`, `alg: "ES256"`; `vct: "https://free-id.org/vct/passport/v1"`; `cnf.jwk` = `{ kty: "OKP", crv: "Ed25519", x: <credential public key base64url> }`; presentation = `issuerJwt~disclosure1~…~disclosureN~kbJwt`; KB-JWT header `typ: "kb+jwt"`, `alg: "EdDSA"`, payload `{ aud, nonce, iat, sd_hash }` where `sd_hash` = base64url(SHA-256(ASCII `issuerJwt~d1~…~dN~`)).
- JWE: compact, `alg: "ECDH-ES"`, `enc: "A256GCM"`, P-256 `epk`, `kid` of the recipient key, `cty: "dc+sd-jwt"`; key derivation per RFC 7518 §4.6 (Concat KDF, SHA-256, empty apu/apv, keydatalen 256).
- Pairwise `sub` = base64url(HMAC-SHA256(`NANSEN_PAIRWISE_SECRET`, `${clientId}:${credentialId}`)).
- British English in prose, comments, identifiers, UI copy; Prettier (single quotes, no semicolons, trailing commas) in FreeID; HAC uses its own existing style (double quotes, no semicolons); no `any`.
- FreeID tests: `pnpm --filter auth-server run test -- <pattern>` in a fresh clean clone (the worktree's node_modules are stale). Mobile util tests: `NODE_OPTIONS=--experimental-vm-modules pnpm exec jest <path>` from the FreeID root. NYC Fibre: `node --test nyc-fibre/test/`. HAC: `pnpm test` in `agentic-system`.
- Branches: FreeID work on `feat/verify-with-freeid` created from `feat/on-device-passport-verification` in the worktree `/Users/ray/Documents/projects/2026.nosync/free-identity-passport-wt`. HAC + NYC Fibre work on `feat/verify-with-freeid` in `/Users/ray/Documents/projects/2026.nosync/human-anchored-agentic-chain`.
- Deployments and production secrets are done by the controller with Emmanuel's go-ahead, not by task implementers.

## Review Focus

1. The phone releases a field the relying party did not request (e.g. full `document_number` when only `passport:number_masked` was asked) → must be impossible: the consent screen offers only requested fields, full number off by default (Task 6 test of `selectDisclosures`).
2. A presentation replayed to a different relying party or a later sign-in → NYC Fibre rejects on `aud`/`nonce` mismatch (Task 7 tests).
3. FreeID restarts between enrolment and release → issuer JWT still verifies because the signing key is persistent (Task 1 test).
4. A credential issued before this change (no SD-JWT stored on the phone) tries to release → the phone says "Re-scan your passport to enable sharing" instead of crashing (Task 6).
5. The agent's browser lands on FreeID's QR page → it can observe/scroll but any click or typing there is refused (Task 8 test).

---

### Task 1: Persistent FreeID signing key

**Repo:** FreeID worktree. **Files:** Modify `apps/auth-server/src/modules/oidc/well-known/jwks.service.ts`; Test `apps/auth-server/src/modules/oidc/well-known/__tests__/jwks.service.spec.ts`.

**Interfaces — Produces:** `JwksService` unchanged API (`getJwks()`, `getPrivateKey()`, `getPublicKey()`, `getKeyId()`); new env `FREEID_SIGNING_JWK` (private EC P-256 JWK JSON) and optional `FREEID_SIGNING_KID`.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from '@jest/globals'
import { generateKeyPairSync, sign, verify } from 'crypto'
import { JwksService } from '../jwks.service'

describe('JwksService', () => {
  it('loads a persistent key from FREEID_SIGNING_JWK so signatures survive restarts', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    process.env.FREEID_SIGNING_JWK = JSON.stringify(privateKey.export({ format: 'jwk' }))
    process.env.FREEID_SIGNING_KID = 'freeid-test-1'
    const first = new JwksService()
    const second = new JwksService()
    const signature = sign('sha256', Buffer.from('x'), first.getPrivateKey())
    expect(verify('sha256', Buffer.from('x'), second.getPublicKey(), signature)).toBe(true)
    expect(first.getKeyId()).toBe('freeid-test-1')
    expect(JSON.stringify(first.getJwks())).not.toContain('"d"')
    delete process.env.FREEID_SIGNING_JWK
    delete process.env.FREEID_SIGNING_KID
  })

  it('falls back to an ephemeral key when no persistent key is configured', () => {
    delete process.env.FREEID_SIGNING_JWK
    expect(new JwksService().getKeyId()).toBe('freeid-local-key')
  })
})
```

- [ ] **Step 2:** Run in a clean clone; expect FAIL (first test).
- [ ] **Step 3: Implement.** In the constructor: if `process.env.FREEID_SIGNING_JWK` is set, `createPrivateKey({ key: JSON.parse(…), format: 'jwk' })`, derive the public key with `createPublicKey(privateKey)`, and set `keyId = process.env.FREEID_SIGNING_KID ?? 'freeid-signing-1'`; otherwise keep today's `generateKeyPairSync` + `'freeid-local-key'`. Log a warning in the fallback branch ("Ephemeral OIDC signing key — tokens and credentials break on restart").
- [ ] **Step 4:** Tests pass; lint the file.
- [ ] **Step 5:** Commit `feat(oidc): load a persistent signing key from FREEID_SIGNING_JWK`.

---

### Task 2: FreeID signs an SD-JWT over attested digests at issuance

**Repo:** FreeID worktree. **Files:** Modify `apps/auth-server/src/modules/authn/nansen/nansen-issuance.util.ts`, `nansen-issuance.service.ts`, `nansen.controller.ts` (issue/attested response); Create `apps/auth-server/src/modules/authn/nansen/sd-jwt-issuer.ts`; Tests `__tests__/nansen-issuance.util.spec.ts`, `__tests__/sd-jwt-issuer.spec.ts`, `__tests__/nansen-issuance.service.spec.ts`.

**Interfaces — Consumes:** `JwksService` (Task 1). **Produces:**
- `IssuanceClientData` gains `sdAlg: 'sha-256'` and `sdDigests: string[]` (JSON keys `sd_alg`, `sd_digests`); both required.
- `issueSdJwt(input: { publicKey: string; digests: string[]; checks: IssuanceChecks; attested: true }, signer: { privateKey: KeyObject; keyId: string; issuer: string }): Promise<string>` returns the compact issuer JWT.
- `issueAttested` result gains `sdJwt?: string` on ISSUED and REISSUED; the controller responds `{ status_code, credential_id, sd_jwt }`.

- [ ] **Step 1: Failing tests.**
  - util: client data with `sd_alg: 'sha-256'` and 1–16 unique 43-char base64url `sd_digests` parses; missing, empty, more than 16, duplicated, or non-43-char digests → `null`; `sd_alg` other than `sha-256` → `null`.
  - issuer:
```ts
it('signs an SD-JWT issuer JWT holding only digests and the holder key', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const digests = [Buffer.alloc(32, 1).toString('base64url'), Buffer.alloc(32, 2).toString('base64url')]
  const holder = Buffer.alloc(32, 9).toString('base64url')
  const jwt = await issueSdJwt(
    { publicKey: holder, digests, checks: CHECKS, attested: true },
    { privateKey, keyId: 'k1', issuer: 'https://api.free-id.org' },
  )
  const { payload, protectedHeader } = await jwtVerify(jwt, publicKey, { issuer: 'https://api.free-id.org' })
  expect(protectedHeader).toMatchObject({ alg: 'ES256', typ: 'dc+sd-jwt', kid: 'k1' })
  expect(payload).toMatchObject({
    vct: 'https://free-id.org/vct/passport/v1',
    _sd_alg: 'sha-256',
    _sd: [...digests].sort(),
    cnf: { jwk: { kty: 'OKP', crv: 'Ed25519', x: holder } },
    verification: { passive_authentication: true, csca_chain: true, liveness: 'blink', face_match: 'not_performed', app_attest: true },
  })
  expect(JSON.stringify(payload)).not.toMatch(/given_name|birthdate|document_number/)
})
```
  - service: a valid attested request returns `sdJwt` whose `_sd` equals the client data's digests; the existing tests keep passing with `sd_alg`/`sd_digests` added to their client data fixtures.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3: Implement.** `sd-jwt-issuer.ts` uses `jose` `SignJWT` with header `{ alg: 'ES256', typ: 'dc+sd-jwt', kid }`, payload as in the test, `setIssuer`, `setIssuedAt`. `parseIssuanceClientData` validates and returns `sdAlg`/`sdDigests`. `NansenIssuanceService` takes `JwksService` (export it from the OIDC module if needed) and the issuer from config; after the existing checks and a successful `issueAttestedCredential` with status ISSUED or REISSUED, sign and return `sdJwt`. Digests are bound because they are inside the attested client data string.
- [ ] **Step 4:** All auth-server tests pass in a clean clone; lint changed files.
- [ ] **Step 5:** Commit `feat(nansen): sign an SD-JWT VC over attested field digests at issuance`.

---

### Task 3: Release flow on the FreeID server

**Repo:** FreeID worktree. **Files:** Modify `modules/oidc/services/client.service.ts` (register `nyc-fibre`), `modules/oidc/oidc.controller.ts` (authorize: release detection + frontend redirect; token: hand the release blob to `/userinfo`), `common/interfaces/auth-session-data.interface.ts`, `modules/authn/nansen/nansen.controller.ts` (`qr-challenge` release payload; new `POST /nansen/release`), `nansen.dto.ts`, `nansen.enum.ts`, `nansen.service.ts` (`pairwiseSubject`, `verifyReleaseSignature`), `config/index.ts` (`nansen.pairwiseSecret` ← `NANSEN_PAIRWISE_SECRET`); Tests in the matching `__tests__`.

**Interfaces — Produces:**
- Client `nyc-fibre`: `jwksUri` `https://nyc-fibre.vercel.app/.well-known/jwks.json`, redirect `https://nyc-fibre.vercel.app/api/callback`, `allowedScopes` `openid passport passport:name passport:birthdate passport:nationality passport:expiry passport:number_masked passport:number`; `OidcClient` gains optional `clientUri` (`https://nyc-fibre.vercel.app`).
- Session gains `release?: { fields: string[]; clientName: string; jwksUri: string }` and `releaseBlob?: string`.
- `/authorize`: when scopes include `passport`, set `session.release` (fields mapped from `passport:*` scopes per Global Constraints) and redirect to `${FRONTEND_URL}/auth?flow=release`.
- `GET /nansen/qr-challenge` for a release session returns `{ sessionId, challenge, issuer, flow: 'release', clientId, clientName, fields, nonce, jwksUri }`.
- `POST /nansen/release` body `{ sessionId, challenge, signature, publicKey, jwe?: string, deny?: boolean }` → `{ status_code, redirect_uri? }` with codes `NANSEN_R0001` RELEASED, `R0002` DENIED, `R0003` CHALLENGE_INVALID, `R0004` INVALID_SIGNATURE, `R0005` CREDENTIAL_NOT_VERIFIED.
- `pairwiseSubject(clientId: string, credentialId: string): string`.

- [ ] **Step 1: Failing tests** covering: authorize with `passport` scopes stores `session.release` and redirects to `/auth?flow=release`; an unknown `passport:*` scope is rejected by the existing scope check; qr-challenge returns the release payload; release with a valid signature from a credential with `verifiedAt` stores `releaseBlob`, elevates the session with `userId = pairwiseSubject('nyc-fibre', credential.id)` and returns `redirect_uri`; unverified credential → `R0005`; wrong signature → `R0004`; challenge mismatch → `R0003`; `deny: true` with a valid signature → `R0002` and `nansenRedirectUri` set to `${redirectUri}?error=access_denied&state=…`; pairwise subjects differ per client and are stable per client; the token endpoint, for a code whose session carries `releaseBlob`, calls `backchannelService.storeClaimsForToken(access_token, releaseBlob)` so `/userinfo` returns it as `application/jwt`.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3: Implement.** Before adding the token hook, confirm that `oidcService.generateRedirectUri(session)` stores the session snapshot that `/token` later reads via `getAuthorizationRequest(code)`; set `releaseBlob` on the session before calling `elevateSession`. Signature check reuses `verifyEd25519Signature`. Never parse or log the JWE; log only status codes.
- [ ] **Step 4:** Tests pass in a clean clone; lint.
- [ ] **Step 5:** Commit `feat(nansen): release passport fields to a relying party via a QR sign-in`.

---

### Task 4: FreeID sign-in page shows the release QR

**Repo:** FreeID worktree. **Files:** Create `apps/auth-frontend/src/app/auth/ReleaseQr.tsx`; Modify `apps/auth-frontend/src/app/auth/page.tsx`.

**Interfaces — Consumes:** Task 3's qr-challenge payload and the existing `GET /nansen/poll`.

- [ ] **Step 1:** In `page.tsx`, read `flow` from the URL (`useSearchParams`, inside the existing Suspense pattern if one exists, otherwise add one); when `flow === 'release'` render only `<ReleaseQr />` (no password/SWK tabs).
- [ ] **Step 2:** `ReleaseQr` fetches `/nansen/qr-challenge`, renders `<QRCodeSVG value={JSON.stringify(payload)} size={240} />` with heading "`{clientName}` wants to verify your identity", a list of the requested fields in plain words (Name, Date of birth, Nationality, Passport expiry, Masked passport number, Full passport number), and "Scan with the FreeID app. Your phone shows exactly what will be shared." Poll `/nansen/poll` every 2 s and `window.location.href = redirect_uri` when present (same pattern as `QrLoginTab`).
- [ ] **Step 3:** `pnpm --filter auth-frontend run lint` and `pnpm --filter auth-frontend run build` pass.
- [ ] **Step 4:** Commit `feat(frontend): release QR on the FreeID sign-in page`.

---

### Task 5: Mobile SD-JWT and JWE utilities

**Repo:** FreeID worktree. **Files:** Create `apps/mobile/src/utils/sdJwt.ts`, `apps/mobile/src/utils/jwe.ts`; Tests `apps/mobile/src/utils/__tests__/sdJwt.test.ts`, `apps/mobile/src/utils/__tests__/jwe.test.ts`; Modify `apps/mobile/package.json` (add `@noble/curves`, `@noble/ciphers`), root `package.json` devDependencies (add `jose` for tests).

**Interfaces — Produces:**
- `type Disclosure = { name: string; value: string; encoded: string; digest: string }`
- `makeDisclosure(name: string, value: string, salt: Uint8Array): Disclosure`
- `buildPresentation(issuerJwt: string, disclosures: Disclosure[], kb: { aud: string; nonce: string; iat: number }, signEd25519: (message: Uint8Array) => Promise<Uint8Array>): Promise<string>`
- `encryptCompactJwe(plaintext: string, recipientJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string; kid?: string }, random: (n: number) => Uint8Array): string`

- [ ] **Step 1: Failing tests.**
  - sdJwt: `makeDisclosure('given_name', 'ALEX', salt)` → `encoded` decodes to `[saltB64, 'given_name', 'ALEX']` and `digest` = base64url(SHA-256(encoded)); `buildPresentation` output has the shape `issuer~d1~d2~kb`, and the KB-JWT verifies with `jose` `jwtVerify` against the Ed25519 public key (`importJWK({ kty:'OKP', crv:'Ed25519', x })`) with `typ: 'kb+jwt'`, `aud`, `nonce`, and `sd_hash` = base64url(SHA-256(`issuer~d1~d2~`)).
  - jwe: a JWE produced by `encryptCompactJwe` decrypts with `jose` `compactDecrypt` using the matching private key to the original plaintext; protected header has `alg: 'ECDH-ES'`, `enc: 'A256GCM'`, `cty: 'dc+sd-jwt'`, the recipient `kid`, and a P-256 `epk`; a different private key fails to decrypt.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3: Implement** with `@noble/hashes` (SHA-256), `@noble/curves` (P-256 ECDH: shared secret x-coordinate), `@noble/ciphers` (AES-256-GCM); Concat KDF per RFC 7518 §4.6.2 with `AlgorithmID = "A256GCM"`, empty `apu`/`apv`, `SuppPubInfo = 256`; compact serialisation `header..iv.ciphertext.tag` (empty encrypted key). Use the libraries' actual export paths for the installed major versions (check `node_modules/@noble/*/package.json` `exports`); base64url helpers local to each file.
- [ ] **Step 4:** Tests pass; mobile `npx tsc --noEmit` shows only the 3 baseline errors.
- [ ] **Step 5:** Commit `feat(mobile): SD-JWT presentation and ECDH-ES JWE utilities`.

---

### Task 6: Mobile enrolment digests and the release consent screen

**Repo:** FreeID worktree. **Files:** Modify `apps/mobile/app/onboard.tsx`, `apps/mobile/app/scan.tsx`, `apps/mobile/src/utils/passportVault.ts` (store SD-JWT + disclosures), `apps/mobile/src/utils/api.ts` (`nansenApi.release`, issue response `sd_jwt`); Create `apps/mobile/app/release.tsx`, `apps/mobile/src/utils/release.ts` (pure `selectDisclosures`); Test `apps/mobile/src/utils/__tests__/release.test.ts`.

**Interfaces — Consumes:** Task 5 utilities; Task 2 `sd_jwt`; Task 3 QR payload and `POST /nansen/release`. **Produces:** `selectDisclosures(stored: Disclosure[], requestedFields: string[], allowFullNumber: boolean): Disclosure[]`.

- [ ] **Step 1: Failing test for `selectDisclosures`:** returns only requested fields; `document_number` excluded unless both requested and `allowFullNumber`; `passport:name` maps to both `given_name` and `family_name`; unknown field names ignored.
- [ ] **Step 2: Enrolment.** In `handleFaceVerified`, build disclosures for the seven fields (Global Constraints; `birthdate`/`passport_expiry` as YYYY-MM-DD, `nationality` from the passport, masked number per rule) with fresh 16-byte salts; add `sd_alg` and sorted `sd_digests` to `clientData` before hashing for App Attest; on ISSUED/REISSUED store `sd_jwt` and the encoded disclosures in the Face ID-gated vault (new SecureStore key alongside the passport).
- [ ] **Step 3: Release.** `scan.tsx`: `flow === 'release'` → `router.push('/release', { payload: JSON.stringify(qr) })`. `release.tsx`: show `clientName` and requested fields as toggles (all requested fields on except full number, which is off and visually highlighted "Full passport number — only share if you trust {clientName}"); Approve → Face ID vault read → if no stored SD-JWT, show "Re-scan your passport to enable sharing" → fetch `jwksUri`, pick the key with `use === 'enc'` → `buildPresentation(sdJwt, selectDisclosures(...), { aud: clientId, nonce, iat: now })` signed with the credential key → `encryptCompactJwe` → sign the challenge → `nansenApi.release({ sessionId, challenge, signature, publicKey, jwe })`. Deny → `nansenApi.release({ …, deny: true })`.
- [ ] **Step 4:** Release util test passes; mobile `npx tsc --noEmit` only baseline errors; Prettier on changed files.
- [ ] **Step 5:** Commit `feat(mobile): enrol field digests and share passport fields with consent`.

---

### Task 7: NYC Fibre verifies real releases

**Repo:** HAC. **Files:** Create `nyc-fibre/api/verify.js`, `nyc-fibre/test/verify.test.js`, `nyc-fibre/api/result.js`; Modify `nyc-fibre/api/_lib.js` (encryption key, scopes), `nyc-fibre/api/login.js` (scopes from query: `?full=1` adds `passport:number`), `nyc-fibre/api/callback.js` (code → token → ID token → `/userinfo` → decrypt + verify → sealed result cookie → redirect `/?freeid=verified`), `nyc-fibre/api/jwks.js` (publish `sig` and `enc` keys), `nyc-fibre/index.html` (real mode: save signup progress to `sessionStorage`, redirect to `/api/login`, restore on return, render the verified panel from `/api/result`); Delete `nyc-fibre/api/poll.js` (CIBA approach superseded); Update `nyc-fibre/.vercelignore` (stop ignoring `api`, `package.json`, `vercel.json`; ignore `test`).

**Interfaces — Produces:** `verifyRelease({ jwe, encPrivateJwk, issuerJwks, issuer, clientId, nonce, now }): Promise<{ fields: Record<string, string>, verification: object, holderKey: object }>` throwing `Error` with a specific message per failure.

- [ ] **Step 1: Failing tests** (`node:test`, fixtures built with `jose`: an ES256 "FreeID" key, an Ed25519 holder key, a P-256 encryption key): valid release verifies and returns fields; tampered disclosure (digest not in `_sd`) → "Disclosure not signed by FreeID"; wrong `aud` → "Presentation is for another service"; wrong nonce → "Presentation does not match this sign-in"; `sd_hash` mismatch → "Presentation was altered"; issuer JWT signed by another key → "Not issued by FreeID"; `passport_expiry` in the past → "Passport has expired"; wrong decryption key → "Could not decrypt the release".
- [ ] **Step 2:** Run `node --test nyc-fibre/test/`; expect FAIL.
- [ ] **Step 3: Implement** `verify.js` with `jose` (`compactDecrypt`, `jwtVerify` with `typ` checks, `importJWK`, `createLocalJWKSet`/remote set) and SHA-256 via `node:crypto`; wire the API functions and page. Real mode is the default without `?shots=1`; `?shots=1` keeps today's simulated screenshot mode untouched. The verified panel lists only checks actually verified (issuer signature, passport chip + CSCA chain, genuine app, holder key binding) and the released fields; "Request full number" links to `/api/login?full=1`.
- [ ] **Step 4:** Tests pass; `node -e` syntax check of the inline script as before.
- [ ] **Step 5:** Commit `feat(nyc-fibre): verify FreeID passport releases`.

---

### Task 8: HAC follows FreeID redirects but cannot act on FreeID pages

**Repo:** HAC (`agentic-system`). **Files:** Modify `lib/hac/browser.ts`, `lib/hac/policy.ts` (export `identityProviderOrigins()` from env `IDENTITY_PROVIDER_ORIGINS`, comma-separated origins), `components/control-room.tsx` (show the screenshot's page host instead of the hardcoded "Clearance demo"; when the latest page is an identity-provider origin, show "Scan this code with your FreeID app" above the screenshot), `agent/instructions.md`, `agent/subagents/browser_worker/instructions.md`; Test `tests/browser.test.ts`.

**Interfaces — Produces:** `identityProviderOrigins(): string[]`.

- [ ] **Step 1: Failing test** in `tests/browser.test.ts`: start a second local fixture server as the identity provider; set `IDENTITY_PROVIDER_ORIGINS` to it; the target page redirects there on a click; assert the redirect loads (screenshot `pageUrl` is on the IdP origin), `inspect` and `scroll` succeed there, and `click`/`type` there are refused with "Identity provider pages are view-only for the agent"; a direct `navigate` to the IdP origin is still denied by policy; requests to a third origin are still blocked.
- [ ] **Step 2:** `pnpm test`; expect FAIL.
- [ ] **Step 3: Implement.** Route handler: allow when the request origin is the scope origin or in `identityProviderOrigins()`. Page-origin guard for non-navigate actions: scope origin → as today; identity-provider origin → allow `inspect`/`scroll`/`close`, throw the view-only error for `click`/`type`/`press`; any other origin → as today. Instructions: at the identity step choose "Verify with FreeID", tell the human to scan the code shown in Task details and approve on their phone, then `inspect` (no more than once every 15 seconds) until back on the target site; remove the "Simulate phone approval" guidance; never handle identity fields.
- [ ] **Step 4:** `pnpm test`, `pnpm typecheck`, `pnpm lint` pass.
- [ ] **Step 5:** Commit `feat(hac): let the agent follow identity-provider redirects without acting on them`.

---

### Task 9: Deployment runbook (controller, with Emmanuel's go-ahead)

Not a code task; the controller performs these after Tasks 1–8 pass review.

1. Generate and set FreeID secrets (Fly `free-identity-auth`): `FREEID_SIGNING_JWK` (new P-256 private JWK), `FREEID_SIGNING_KID`, `NANSEN_PAIRWISE_SECRET` (32 random bytes). Deploy the FreeID branch. Existing sessions/tokens become invalid (acceptable).
2. Deploy the FreeID frontend (Vercel project for `www.free-id.org`) from the branch.
3. NYC Fibre (Vercel `nyc-fibre`, personal scope): set `NYF_PRIVATE_JWK` (P-256 signing), `NYF_ENC_PRIVATE_JWK` (P-256 encryption), `COOKIE_SECRET`; deploy; check `/.well-known/jwks.json` lists both keys.
4. HAC runtime (Fly `hac-agentic-runtime`): set `IDENTITY_PROVIDER_ORIGINS=https://api.free-id.org,https://www.free-id.org`; deploy runtime; deploy the Vercel web app.
5. New iOS build (cloud EAS with auto-submit, or local) → TestFlight.
6. Emmanuel re-scans his passport in the new build (re-issuance stores the SD-JWT), then runs: NYC Fibre in a normal browser → Verify with FreeID → scan → approve → verified panel with real fields; then "Request full number"; then the HAC-driven flow.
