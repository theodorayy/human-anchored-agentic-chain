# NYC age-verification bar: FreeID door check

A mock relying party for FreeID: a bar door's age check. The bouncer taps **18+** or **21+**. FreeID's page shows a QR code, the guest scans it with the FreeID app and approves sharing their NYS licence age flags. The screen then shows a big green **YES**, a red **NO** or an amber **CAN'T CONFIRM**.

Production: https://nyc-age-verif-bar.vercel.app

It is built like `../nyc-fibre`: vanilla HTML, Vercel Node functions in `api/` and `node:test` tests. The verifier is copied and trimmed from NYC Fibre's, not imported.

## What it asks for and what it keeps

- Scopes: `openid licence licence:age_flags`, and nothing else. No passport scope, no name and no date of birth.
- The release may hold only the `nys_licence` container (identity/v1) and, inside it, `under_18_until`, `under_19_until` and `under_21_until`. If any other field arrives (a passport field, the licence birthdate, name, address or number), the whole release is refused, even when FreeID signed that field.
- Decision for threshold N, using `under_N_until`:
  - today ≥ that date gives **YES** (the birthday itself counts);
  - otherwise **NO**;
  - if the flag is missing, or no licence was shared at all, the answer is **CAN'T CONFIRM**. It is never YES.
- "Today" is the date in New York (`BAR_TIME_ZONE`, default `America/New_York`), not UTC. Under UTC, a guest turning 21 tomorrow would get YES from about 20:00 tonight.
- Nothing is stored. The flag dates go no further than `api/callback.js`. The browser receives only `{ min, decision }`, in a sealed HttpOnly cookie that lasts 120 seconds and can be read once (`/api/result`).
- The page shows "Age from NYS licence barcode — not verified by New York State" with every YES or NO. The barcode carries no issuer signature.
- The bouncer has nothing to type or override. The only controls are 18+, 21+ and Next guest. `/api/login` accepts `min=18` or `min=21` and nothing else. The threshold lives in the sealed flow cookie, so FreeID never sees it and the callback cannot be steered to a different one.

The release is verified like this:

1. It is a JWE (ECDH-ES, A256GCM) encrypted to our `enc` key.
2. The issuer JWT is ES256 from `https://api.free-id.org`, with `typ dc+sd-jwt` and vct passport/v1 or identity/v1.
3. The passport chip and App Attest checks are true.
4. identity/v1 has exactly 3 top-level digests.
5. Every disclosure matches a signed digest at the right level.
6. The container's `verification` block is exactly what the contract specifies, and `valid_until` is not in the past.
7. The KB-JWT is EdDSA, signed by the `cnf` key, with `aud` = our client id, our `nonce`, ≤ 5 minutes old and a matching `sd_hash`.

## Outcomes and reason codes

Any rejected or failed check redirects to `/?freeid=error&reason=<code>`, and the page shows fixed copy for each code:

| Code | Meaning |
| --- | --- |
| `declined` | The guest declined on the phone |
| `expired` | The flow cookie is missing or expired, or the state didn't match |
| `signin` | The token exchange or ID token failed |
| `unavailable` | FreeID couldn't be reached, or no release came back |
| `decrypt` | The release wasn't encrypted to our key |
| `issuer` | The credential wasn't issued by FreeID, or has the wrong shape |
| `chip` | The passport chip or App Attest check isn't verified |
| `binding` | The KB-JWT failed: holder key, aud, nonce, freshness or sd_hash |
| `fields` | An unrequested, unknown, forged, duplicate or malformed disclosure |
| `licence_expired` | The licence's `valid_until` has passed |
| `threshold` | The check was started without exactly 18 or 21 |
| `error` | Anything else |

## Environment variables

| Name | Required | Value |
| --- | --- | --- |
| `BAR_PRIVATE_JWK` | yes | Private P-256 JWK that signs `private_key_jwt` client assertions (published as kid `nyc-age-verif-bar-1`, `use: sig`) |
| `BAR_ENC_PRIVATE_JWK` | yes | Private P-256 JWK that the guest's phone encrypts releases to (published as kid `nyc-age-verif-bar-enc-1`, `use: enc`, `ECDH-ES`) |
| `COOKIE_SECRET` | yes | HMAC key for the sealed flow and result cookies |
| `FREEID_ISSUER` | no | Default `https://api.free-id.org` |
| `FREEID_CLIENT_ID` | no | Default `nyc-age-verif-bar` |
| `APP_URL` | no | Default `https://nyc-age-verif-bar.vercel.app` (the redirect URI is `${APP_URL}/api/callback`) |
| `BAR_TIME_ZONE` | no | Default `America/New_York` |

Generate all three secrets with:

```sh
npm install
node scripts/gen-keys.mjs   # prints BAR_PRIVATE_JWK=…, BAR_ENC_PRIVATE_JWK=…, COOKIE_SECRET=…
```

Add each one to the Vercel project (Production), e.g. `vercel env add BAR_PRIVATE_JWK production` and paste the JSON. Never commit them. The public halves are served at `/.well-known/jwks.json`, which is rewritten to `/api/jwks`.

## FreeID client registration it needs

The FreeID auth server needs this entry in `apps/auth-server/src/modules/oidc/services/client.service.ts`. As of 2026-11-02 it is already present in the `free-identity-passport-wt` worktree, and the scope is listed in `oidc/constants`.

```ts
[
  'nyc-age-verif-bar',
  {
    clientId: 'nyc-age-verif-bar',
    clientName: 'NYC Bar age check (demo)',
    clientUri: 'https://nyc-age-verif-bar.vercel.app',
    jwksUri: 'https://nyc-age-verif-bar.vercel.app/.well-known/jwks.json',
    redirectUris: ['https://nyc-age-verif-bar.vercel.app/api/callback'],
    allowedScopes: ['openid', 'licence', 'licence:age_flags'],
  },
],
```

FreeID must also support the following, from the NYS licence contract:

- a licence-only release, where the `licence` umbrella alone makes `/authorize` a release;
- the `licence:age_flags` → `licence.under_{18,19,21}_until` mapping.

## Deploy

Do this once the env vars are set and FreeID has the client registered:

```sh
vercel deploy --prod --scope emmanuel-rs-projects-695f4769
```

## Tests

```sh
npm test
```

The tests use synthetic credentials (`test/fixtures.js`, adapted from NYC Fibre's builder). They cover:

- YES, NO and CAN'T CONFIRM at 18+ and 21+, including a birthday today and tomorrow;
- the New York vs UTC boundary;
- rejection of extra licence fields and of passport fields;
- forged or added disclosures and a forged container;
- the wrong nonce or aud, a stale or altered presentation, and the wrong keys;
- an expired licence;
- the full login, callback and result flow against a stand-in FreeID;
- page checks: no form fields, and fixed copy for every reason code.
