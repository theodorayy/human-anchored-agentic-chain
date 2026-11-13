import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createServer, type Server } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SignJWT } from "jose"
import { buildRelease, k, FIELDS, LICENCE_FIELDS } from "./fixtures/freeid.js"
import { createMandate } from "../lib/hac/control-plane"
import { transaction } from "../lib/hac/store"
import { vaultKeys } from "../lib/hac/vault"
import { beginRelease, finishRelease, identityStatus, requestIdentity } from "../lib/hac/identity"
import { GET as jwks } from "../app/.well-known/jwks.json/route"

const directory = mkdtempSync(join(tmpdir(), "hac-identity-"))
process.env.HAC_DATA_DIR = directory
process.env.HAC_VAULT_KEY = "22".repeat(32)
process.env.APP_URL = "http://localhost:3003"
process.env.OIDC_CLIENT_ID = "hac-agentic-system-web"
process.env.OIDC_CLIENT_PRIVATE_JWK = JSON.stringify(k.sigPrivate)
process.env.OIDC_ENC_PRIVATE_JWK = JSON.stringify(k.encPrivate)

let server: Server, issuer = ""
let sub = "pairwise-sub", nonce = "", release = ""
before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, issuer)
    const json = (body: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)) }
    if (url.pathname === "/.well-known/openid-configuration") return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, userinfo_endpoint: `${issuer}/userinfo`, jwks_uri: `${issuer}/jwks` })
    if (url.pathname === "/jwks") return json({ keys: [k.freeidPublic] })
    if (url.pathname === "/token") {
      const idToken = await new SignJWT({ nonce, amr: ["nansen"] }).setProtectedHeader({ alg: "ES256", kid: "freeid-1" })
        .setIssuer(issuer).setAudience("hac-agentic-system-web").setSubject(sub).setIssuedAt().setExpirationTime("5m").sign(k.freeid.privateKey)
      return json({ id_token: idToken, access_token: "at-1", token_type: "Bearer" })
    }
    if (url.pathname === "/userinfo") { res.writeHead(200, { "content-type": "application/jwt" }); return res.end(release) }
    res.writeHead(404).end()
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.OIDC_ISSUER = issuer
})
after(() => { server.close(); rmSync(directory, { recursive: true, force: true }) })

const principalFor = (s: string) => ({ id: createHash("sha256").update(`${issuer}\0${s}`).digest("hex"), name: "P", provider: "oidc" as const })

async function startFlow(principal: ReturnType<typeof principalFor>) {
  const m = createMandate(principal, { title: "Identity test", maxActions: 5, durationHours: 1, requireApproval: true })
  assert.deepEqual(transaction(s => requestIdentity(s, principal.id, m.id)), { status: "pending" })
  const redirect = await beginRelease(principal, m.id)
  assert.equal(redirect.status, 302)
  const authorise = new URL(redirect.headers.get("location")!)
  assert.equal(authorise.searchParams.get("redirect_uri"), "http://localhost:3003/api/freeid/callback")
  assert.ok(authorise.searchParams.get("scope")!.includes("licence:address"))
  nonce = authorise.searchParams.get("nonce")!
  const state = authorise.searchParams.get("state")!
  return { m, callback: new Request(`http://localhost:3003/api/freeid/callback?code=c1&state=${state}`) }
}

test("a verified release fills the vault and ends the request", async () => {
  const principal = principalFor("pairwise-sub"); sub = "pairwise-sub"
  const { m, callback } = await startFlow(principal)
  release = await buildRelease({ identity: true, licence: {}, aud: "hac-agentic-system-web", iss: issuer, nonce, now: new Date() })
  const done = await finishRelease(callback, principal)
  assert.equal(done.headers.get("location"), "http://localhost:3003/workspace?identity=ready")
  const keys = transaction(s => vaultKeys(s, m.id))
  assert.ok(keys.includes("passport.family_name") && keys.includes("attestation") && keys.includes("licence.address"))
  assert.equal(transaction(s => identityStatus(s, m.id)), "ready")
  assert.equal(transaction(s => requestIdentity(s, principal.id, m.id)).status, "ready")
})

test("release from another account is rejected", async () => {
  const principal = principalFor("signed-in-sub")
  const { m, callback } = await startFlow(principal)
  sub = "someone-else"
  release = await buildRelease({ identity: true, aud: "hac-agentic-system-web", iss: issuer, nonce, now: new Date() })
  const done = await finishRelease(callback, principal)
  assert.equal(done.headers.get("location"), "http://localhost:3003/workspace?identity=failed")
  assert.deepEqual(transaction(s => vaultKeys(s, m.id)), [])
})

test("a mismatched-nonce release is rejected and logs no values", async () => {
  const principal = principalFor("nonce-sub"); sub = "nonce-sub"
  const { m, callback } = await startFlow(principal)
  release = await buildRelease({ identity: true, licence: {}, aud: "hac-agentic-system-web", iss: issuer, nonce: "wrong", now: new Date() })
  const lines: string[] = []
  const original = { error: console.error, log: console.log, warn: console.warn }
  console.error = console.log = console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(" ")) }
  try {
    const done = await finishRelease(callback, principal)
    assert.equal(done.headers.get("location"), "http://localhost:3003/workspace?identity=failed")
  } finally { Object.assign(console, original) }
  assert.deepEqual(transaction(s => vaultKeys(s, m.id)), [])
  const output = lines.join("\n")
  for (const value of [FIELDS.family_name, FIELDS.birthdate, LICENCE_FIELDS.address.street_address]) assert.equal(output.includes(value), false, value)
})

test("a callback with an unknown state is rejected", async () => {
  const principal = principalFor("state-sub")
  const done = await finishRelease(new Request("http://localhost:3003/api/freeid/callback?code=c1&state=nope"), principal)
  assert.equal(done.headers.get("location"), "http://localhost:3003/workspace?identity=failed")
})

test("jwks publishes the encryption key without private parts", async () => {
  const body = await (await jwks()).json() as { keys: Record<string, string>[] }
  const enc = body.keys.find(key => key.use === "enc")
  assert.ok(enc)
  assert.equal(enc.kid, "hac-rp-enc")
  assert.equal(body.keys.some(key => "d" in key), false)
})
