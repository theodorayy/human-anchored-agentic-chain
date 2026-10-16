# Verify with FreeID: selective disclosure to a relying party (Phases 1c + 1d)

Status: draft for review, 2026-10-09. Owner: Emmanuel Rayendra.
Spans: `free-identity` (server + iOS app), `nyc-fibre` (mock ISP), `agentic-system` (HAC).
Builds on: free-identity specs `2026-10-01-on-device-passport-verification.md` (1a) and `2026-10-09-face-match-design.md` (1b).

## Goal

In the relocation demo, the HAC agent signs the user up for home internet at NYC Fibre and reaches the identity step. NYC Fibre's "Verify with FreeID" releases the user's passport-backed details **from their phone**, with their approval, **encrypted to NYC Fibre**. NYC Fibre verifies the details came from a passport-verified, attested FreeID credential. FreeID never sees the details; the agent never holds them.

## Decisions already made (2026-10-01)

- Mode 2 only: the relying party (NYC Fibre) is FreeID's client; HAC only carries the task.
- Trust model: **salted hashes at enrolment** (SD-JWT VC). Values are fixed when the passport is verified.
- Hand-off: **QR shown to the user via HAC**; the user scans with the FreeID app.
- Fields: name, date of birth, passport validity, face matched, passport number **masked by default** (e.g. `••••••329P`); the **full number only on an explicit request**, with its own highlighted consent.

## Changes from the chat design (please confirm)

1. **No FreeID account needed.** A passport credential alone can verify with a relying party. The relying party receives a per-client pseudonymous `sub` (pairwise), so two services can't correlate the user by `sub` alone. They can still correlate the user through the presentation itself: see Known limits.
2. **Expiry, not a validity flag.** "Passport valid" is released as the disclosed expiry date (`passport_expiry`); the relying party checks it. A boolean fixed at enrolment would go stale, and putting the expiry in FreeID's signature metadata would show passport data to FreeID.
3. **The phone fetches the relying party's encryption key itself** from the relying party's registered JWKS URL, so FreeID never holds or relays the key. The JWKS URL itself comes from FreeID's client registry, so this protects against an honest-but-curious FreeID, not a compromised one: see Known limits.
4. **Not CIBA.** This uses an ordinary OIDC authorization-code flow plus a QR. The existing CIBA backchannel is untouched.

## 1. Enrolment: FreeID signs salted hashes (1c)

At attested issuance (1a flow), after passive authentication and face match (1b):

- The phone builds one **disclosure** per field: `base64url(JSON [salt, name, value])`, salt = 16 random bytes. Fields: `given_name`, `family_name`, `birthdate`, `issuing_country`, `passport_expiry`, `document_number_masked`, `document_number`, `face_match` (`true`).
- Digest per disclosure: `base64url(SHA-256(disclosure))`. The sorted digest list goes into the App Attest client data (`sd_digests`, `sd_alg: "sha-256"`), so the attestation binds them.
- After verifying the attestation, FreeID signs an **SD-JWT VC issuer JWT** (its existing ES256 OIDC key, `typ: dc+sd-jwt`): `iss`, `iat`, `vct: "https://free-id.org/vct/passport/v1"`, `_sd_alg`, `_sd` (the digests), `cnf.jwk` (the credential's Ed25519 public key), and non-personal `verification` (`passive_authentication`, `csca_chain`, `liveness`, `face_match`, `app_attest`). FreeID sees digests only.
- The issuance response returns the issuer JWT. The phone stores it and the disclosures in the Face ID-gated vault.
- Rotation (re-scan on a new device) issues a fresh issuer JWT the same way.

## 2. Release: OIDC + QR + SD-JWT presentation (1c)

1. **Relying party → FreeID** `/authorize` (code + PKCE + nonce) with scopes `openid passport` plus one scope per requested field: `passport:name`, `passport:birthdate`, `passport:expiry`, `passport:face_match`, `passport:number_masked`, or `passport:number` (full). Allowed scopes are per client registration.
2. **FreeID login page** shows a QR (`flow: "release"`): session ID, challenge, client ID, client name, requested fields, the client's `jwks_uri`, and the relying party's nonce.
3. **Phone** scans → consent screen listing each requested field (masked number on by default; a full-number request is highlighted and needs its own toggle) → Face ID → builds the **presentation**: issuer JWT + selected disclosures + a key-binding JWT (`aud` = client ID, `nonce`, `iat`, `sd_hash`) signed with the credential key → fetches the relying party's JWKS and **encrypts** the presentation as a JWE (ECDH-ES + A256GCM) to its `use: "enc"` key.
4. **Phone → FreeID** `POST /nansen/release`: session ID, signature over the challenge, the JWE. FreeID verifies the signature against a credential with `verifiedAt` set, then completes the authorization with `sub` = pairwise(client, credential), `amr: ["nansen"]`. The JWE is stored unread for single pickup.
5. **Relying party** exchanges the code (`private_key_jwt`), verifies the ID token, then `GET /userinfo` returns the JWE (`application/jwt`) once.
6. **Relying party** decrypts, verifies the issuer JWT against FreeID's JWKS, checks each disclosure's digest is in `_sd`, verifies the key-binding JWT with `cnf.jwk`, `aud`, `nonce`, freshness and `sd_hash`, and checks `passport_expiry` is in the future.

Denial on the phone → the authorization ends with `access_denied`; nothing is stored.

## 3. NYC Fibre: real "Verify with FreeID" (1d)

- Registered FreeID client `nyc-fibre`: `private_key_jwt`, redirect `https://nyc-fibre.vercel.app/api/callback`, JWKS with a signing key and an encryption key.
- Serverless functions (Vercel): login (authorize redirect, sealed cookie), callback (token exchange, ID token, userinfo, decrypt, verify), and JWKS. Signup progress survives the redirect via `sessionStorage`.
- Verification panel shows what it actually verified (issuer signature, passport chip, genuine app, key binding) and which fields were received, never their values ("Name — received", "Passport valid until — checked", "Passport number — received (masked)"), with "Your details were sent securely to NYC Fibre. They aren't shown on this page." The values stay on NYC Fibre's server; the result cookie and `/api/result` carry field names and checks only, so neither the browser nor an agent driving it holds them. "Request full passport number" starts a second release with `passport:number`.
- `?shots=1` screenshot mode stays, unchanged, for the deck.

## 4. HAC: the QR hand-off (1d)

- A mandate can list **identity-provider origins** (FreeID's API and web origins). The worker may be redirected there and observe, but typing and clicking on those origins are denied by policy.
- When the worker's page is on FreeID's QR page, the task view shows that screenshot to the human with "Scan with your FreeID app", and the worker waits for the redirect back to the authorised site.
- Agent instructions: at the identity step choose "Verify with FreeID", tell the human to scan, wait; never attempt identity fields itself. The simulated "Simulate phone approval" path is removed from instructions.
- The agent never receives the released values; they go to NYC Fibre.

## Testing

- FreeID: issuer-JWT signing over attested digests (rejects digests not in the attested client data); release endpoint (signature, unverified credential refused, single-use pickup, pairwise `sub`).
- NYC Fibre: verification unit tests with fixtures (bad digest, wrong `aud`, wrong nonce, expired passport, tampered issuer JWT, wrong encryption key).
- HAC: policy tests for identity-provider origins (navigate allowed, type/click denied).
- Device: end-to-end with Emmanuel's and Viola's passports, including masked-then-full number.

## Out of scope

PII tokenisation for ordinary sites (mode 1); push notifications; Android; revocation lists; public-chain nullifier registry; proof of address; Burke's requirements-breakdown dashboard in HAC (separate UI work).

## Known limits

- Trust in the values rests on the genuine-app attestation at enrolment plus passive authentication; a cloned chip is not detected.
- The relying party sees whatever fields the user approves; the masked number limits but does not remove identifiability.
- **Cross-service correlation.** Every relying party receives the same issuer JWT and the same holder key (`cnf.jwk`), so relying parties can correlate a user across services despite the pairwise `sub`. Fix later with per-relying-party holder keys or credentials, or a zero-knowledge presentation.
- **FreeID sees release events, not values.** FreeID learns which credential released to which client, and when; it never sees the released values.
- **Encryption-key location is FreeID's word.** The relying party's JWKS URL comes from FreeID's client registry; a compromised FreeID could point the phone at a key it controls. The consent screen shows the JWKS host under the client name so the user can notice; that is the only mitigation.
- **The release signature covers the challenge only.** The phone's signature to FreeID covers the challenge, not the JWE, so the pairwise `sub` in the ID token isn't cryptographically tied to the presentation in `/userinfo`.
