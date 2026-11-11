# HAC Agentic System

An Eve web app, styled with shadcn preset `b792x6coKP`, that implements the browser-use branch of the [HAC architecture](../README.md). Free Identity authenticates the human. A root agent owns the conversation and delegates to a browser worker. A non-agentic control plane enforces the human's mandate before each browser action.

**Clearance is an external browser target:** https://clearance-review-demo.vercel.app. Its application and customer data are not copied into this system.

## Run locally

Use Node 24 (`nvm use`) and pnpm. From this directory:

```sh
pnpm install --frozen-lockfile
pnpm setup:local
pnpm exec playwright install chromium
```

`setup:local` creates `.env.local`, generates a private P-256 RP signing key, and preserves existing values. The key is never committed. Add `OPENAI_API_KEY` to `.env.local` to enable live Eve model calls. Both agents use OpenAI `gpt-6.1-sol`, set in `agent/agent.ts` and `agent/subagents/browser_worker/agent.ts` (eve fixes the model at build time). Without a key, sign-in, mandates, browser preview, enforcement, and audit still work; chat clearly reports that the model is offline.

Start FreeID's databases (Docker must be running):

```sh
cd ../free-identity
pnpm install --frozen-lockfile
docker compose --profile databases-only up -d postgres redis
cd ../agentic-system
pnpm dev:freeid
```

Then, in another terminal:

```sh
cd agentic-system # from the HAC repository root
pnpm dev
```

| Service | Default local URL |
| --- | --- |
| HAC / Eve web app | http://localhost:3003 |
| FreeID login UI | http://localhost:3004 |
| FreeID authentication server | http://localhost:3006 |

The separate ports avoid other existing apps on 3000/3001. `dev:freeid` sets the issuer, frontend URL, CORS origin, and WebAuthn origin consistently. Override `FREEID_PORT`, `FREEID_FRONTEND_PORT`, `FREEID_DATABASE_URL`, or `FREEID_REDIS_URL` if needed; update HAC's `OIDC_ISSUER` to match. The app's `APP_URL` must match its public origin for redirects, CSRF checks, and executor dispatch.

1. Choose **Sign in with Free Identity** and complete FreeID authentication.
2. Describe a task, then choose **Review permissions**. Nothing runs yet.
3. Choose **Ask before each interaction** or **Let Eve complete the task**, set an action limit and expiry, then **Confirm & start task**. This creates a human-issued mandate and submits the goal to Eve together. The Principal acts in a personal capacity.
4. The root agent delegates to `browser_worker`. **Task details** shows only that task's browser screenshots and action receipts.
5. **Approve & continue** executes the exact pending interaction and sends a continuation to the same Eve session. The worker inspects the result before proceeding. **Decline** tells Eve not to retry that action.
6. **Audit log** shows readable decisions with expandable technical details; filter by task or export all events. **Stop browser access** revokes the task's mandate and closes its browser contexts.

The diagnostic `/api/browser/preview` endpoint remains available to authenticated operators. It uses a separate browser context and is intentionally absent from the task UI, where the screenshot must represent Eve's actual work.

## FreeID relying party

The public `/` route is a login gate. Authenticated users enter `/workspace`;
direct `/s/:sessionId` visits require both a valid session and ownership of that
Eve conversation. Expired or invalid cookies return visitors to the login page.
The state API also requires authentication.

The FreeID submodule registers `hac-agentic-system` in `apps/auth-server/src/modules/oidc/services/client.service.ts` with:

- Redirect URI: `http://localhost:3003/api/auth/callback`
- Public JWKS: `http://localhost:3003/.well-known/jwks.json`
- Scopes: `openid profile email`
- Client authentication: `private_key_jwt` with ES256

Set `HAC_RP_REDIRECT_URI` and `HAC_RP_JWKS_URI` on FreeID for another host. The JWKS URI must be reachable from FreeID: a Dockerized auth server needs a host-reachable address such as `host.docker.internal`, not the container's own localhost.

The RP uses authorization code + PKCE S256, single-use state bound to an HttpOnly cookie, nonce validation, issuer/audience/signature/expiry verification, and an opaque server-side app session. The public JWKS endpoint exports only the public key fields. This does not weaken or bypass FreeID's existing authentication requirements. Test-only identity entry is disabled by default (`HAC_DEMO=false`).

## Mapping to the diagram

| HAC component | Implementation |
| --- | --- |
| Human Principal | FreeID OIDC → opaque app session |
| Root reasoning agent | `agent/agent.ts`, durable Eve sessions and instructions |
| Control plane | `lib/hac/control-plane.ts`, authenticated API boundary |
| Governance node / PDP | `lib/hac/policy.ts`, SQLite mandates and delegation records |
| Browser / computer-use worker | Declared Eve subagent in `agent/subagents/browser_worker/` |
| Browser execution runtime | `lib/hac/browser.ts`, isolated Chromium contexts |
| Vision grounding | Browser screenshots returned to the worker model via Eve image tool output |
| External service | Existing Clearance website, operated through its browser interface |
| Audit | Server-side records, activity view, authenticated JSON export |

The root has only `inspect_mandate` and the declared browser worker. The worker has only the bounded `browser` tool. Eve's optional shell, file, web-fetch, general delegation, and search tools are disabled. The worker cannot change mandates, approve its own actions, or acquire executor capabilities from model input.

Each session is bound to one human and one mandate at creation. Cross-user session access is rejected at the Eve channel. Parent and child grants are HMAC-signed inside this deployment; validation checks identity binding, parent linkage, scope attenuation, origin, expiry, revocation, action limits, and approvals. These are local operator-verifiable grants, not a cross-organisation delegation protocol.

Browser actions enter a separate HTTP executor endpoint using a server-held, per-action capability. SQLite atomically records decisions and reserves action slots before execution. A completed or already-admitted call is not replayed. Network routing restricts requests and redirects to the authorized origin; popups, downloads, service workers, and WebSockets are blocked. The browser gets no host credentials or user browser profile. Contexts close after ten idle minutes or explicit revocation; the worker is instructed to close on task completion.

## Validation

```sh
pnpm test          # policy, sessions, OIDC protocol fixture, real Chromium boundary
pnpm typecheck
pnpm lint
pnpm build         # Eve backend + Next.js frontend
# With pnpm dev running:
pnpm test:e2e      # task/permission confirmation, scoped evidence, audit, revocation, auth
pnpm test:runtime  # real Eve session + browser subagent, with fixture model output
```

The OIDC unit fixture verifies protocol behavior without requiring a FreeID database. UI tests create isolated test sessions directly in local storage; they do not pretend to test a human FreeID login. The Eve runtime test substitutes deterministic model outputs only in a temporary copy of the authored agent; the production agent always uses its configured provider.

The opt-in `HAC_LIVE_APPROVAL_TEST=1 pnpm exec tsx tests/eve-approval-live.ts` uses the configured model and public UI with an isolated operator-created test identity. It checks the task/permissions dialog, a real evidence-navigation approval, automatic continuation of the same worker, and matching audit entries. It approves only an Evidence-tab click, never a review submission, then revokes and removes its own test records. Run it where the runtime's session key and persistent store are available, as the unprivileged runtime user. Set `HAC_TEST_URL` to select the frontend origin; it defaults to `APP_URL`.

## Prototype boundaries

### Hosted FreeID login

Web app: https://hac-agentic-system.vercel.app

The public Vercel origin proxies the workspace to `hac-agentic-runtime` on Fly.io
when `HAC_RUNTIME_ORIGIN` is set. Authentication runs independently of the agent
executor: encrypted, authenticated cookies hold
short-lived login state and a one-hour identity session. Cookies are HttpOnly,
Secure on HTTPS, bound to the application origin and their purpose, and expire
cryptographically. Logout clears the browser cookie; a copied cookie remains
valid until its one-hour expiry. Rotating the session key invalidates all hosted
sessions. Local sessions retain the SQLite-backed revocation behavior.

The hosted RP is `hac-agentic-system-web` on `https://api.free-id.org`, with its
exact callback and JWKS URLs registered in FreeID. Production configuration:

- `APP_URL=https://hac-agentic-system.vercel.app`
- `OIDC_ISSUER=https://api.free-id.org`
- `OIDC_CLIENT_ID=hac-agentic-system-web`
- `OIDC_CLIENT_PRIVATE_JWK`: private P-256 key, stored as a Vercel secret
- `HAC_SESSION_SECRET`: random 32-byte hexadecimal key, stored as a Vercel secret

PKCE and nonce are carried in the encrypted ten-minute login cookie. FreeID's
single-use authorization code prevents a completed code exchange being replayed.
Only a verified ID token can establish an identity session. No model credentials
or browser authority are stored in these cookies.

Authenticated visitors can open the workspace and architecture view. The Fly
runtime enables mandates, browser execution, and persisted audit. Model-driven
chat additionally requires `OPENAI_API_KEY` on Fly. If the runtime proxy is
not configured, Vercel can still serve authenticated identity and the workspace,
with execution routes closed. Test identity entry is disabled in production.

Deploy from this directory with:

```sh
vercel deploy --prod --project hac-agentic-system --scope emmanuel-rs-projects-695f4769 --yes
```

`.vercelignore` excludes local keys, environment files, databases, screenshots,
and Eve workflow state from deployment uploads.

### Persistent Fly runtime

`fly.toml` defines one `hac-agentic-runtime` machine in `iad`, with 2 GB memory
and the encrypted `hac_data` volume mounted at `/data`. Chromium and the Node
services run as the unprivileged `node` user. Chromium's sandbox remains enabled.
`/data/hac` persists the control plane and screenshots; `/data/eve-workflows`
persists Eve workflow state. The machine stays running to preserve browser
contexts between actions. Browser contexts themselves end on restart; mandates
and audit survive. Do not scale this prototype to multiple machines.

Fly shares `OIDC_CLIENT_PRIVATE_JWK` and `HAC_SESSION_SECRET` with the web app.
`HAC_SESSION_MODE=sealed` preserves existing login sessions when traffic moves
from the standalone Vercel web app to Fly. These identity cookies do not grant
browser authority; each operation still requires a human mandate.

```sh
# From agentic-system/, with Fly credentials configured:
fly deploy --remote-only --ha=false
fly status --app hac-agentic-runtime
```

Set `HAC_RUNTIME_ORIGIN=https://hac-agentic-runtime.fly.dev` on Vercel and
redeploy it to connect the runtime. All paths, including Next assets and Eve
streams, are proxied together so the UI and runtime use the same build. FreeID
continues to use the canonical Vercel callback. Keep the login gate and API
checks enabled on the Fly origin as well.

### Runtime topology

Run this version on a **single Node host with persistent storage**. Both Next and Eve must share the absolute `HAC_DATA_DIR`; Eve workflow state also persists under `.eve/`. The browser context registry lives in the Next process. A serverless deployment needs a separate persistent browser executor and shared database before it can preserve these guarantees. `pnpm build && pnpm start` runs the local production topology.

The worker is a browser-use implementation, not full desktop control or a general OS sandbox. Browser contexts isolate website state; hostile-code isolation beyond Chromium needs a separate worker container/VM. The default target is a fictional-data demo.

An action interrupted after admission is not automatically retried: its outcome may be uncertain, and its reserved action slot remains consumed. Revocation blocks future actions and requests; it cannot undo an effect already sent to the website. An approval authorizes a specific browser action, not the website's semantic business decision. Prefer DOM-aware business-policy adapters before using this against consequential real applications.

The audit store is persisted and access-controlled, but not tamper-evident against the server operator. Organisational mandates, external credential brokering, governance-derived personas/preferences, general API effectors, and multi-host delegation verification are future work.
