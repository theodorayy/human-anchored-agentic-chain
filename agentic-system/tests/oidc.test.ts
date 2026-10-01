import { after, test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { generateKeyPairSync, createHash, randomBytes } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SignJWT, jwtVerify } from "jose"
import { beginLogin, finishLogin } from "../lib/hac/oidc"
import { principalFor, logout } from "../lib/hac/auth"

const directory = mkdtempSync(join(tmpdir(), "hac-oidc-"))
process.env.HAC_DATA_DIR = directory
process.env.APP_URL = "http://localhost:3003"
process.env.OIDC_CLIENT_ID = "hac-agentic-system"
const issuerKeys = generateKeyPairSync("ec", { namedCurve: "P-256" })
const rpKeys = generateKeyPairSync("ec", { namedCurve: "P-256" })
process.env.OIDC_CLIENT_PRIVATE_JWK = JSON.stringify(rpKeys.privateKey.export({ format: "jwk" }))
let nonce = "", challenge = "", tokenNonce = "", assertionVerified = false
const usedCodes = new Set<string>()
const server = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json")
  const issuer = process.env.OIDC_ISSUER!
  if (req.url === "/.well-known/openid-configuration") return res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` }))
  if (req.url === "/jwks") return res.end(JSON.stringify({ keys: [{ ...issuerKeys.publicKey.export({ format: "jwk" }), kid: "fixture", alg: "ES256" }] }))
  if (req.url === "/token") {
    try {
      let raw = ""; for await (const chunk of req) raw += chunk
      const data = new URLSearchParams(raw)
      assert.equal(data.get("client_assertion_type"), "urn:ietf:params:oauth:client-assertion-type:jwt-bearer")
      await jwtVerify(data.get("client_assertion")!, rpKeys.publicKey, { issuer: "hac-agentic-system", subject: "hac-agentic-system", audience: `${issuer}/token` })
      assertionVerified = true
      assert.equal(createHash("sha256").update(data.get("code_verifier")!).digest("base64url"), challenge)
      const code = data.get("code")!
      assert.ok(!usedCodes.has(code))
      usedCodes.add(code)
      const idToken = await new SignJWT({ nonce: tokenNonce || nonce }).setProtectedHeader({ alg: "ES256", kid: "fixture" }).setIssuer(issuer).setAudience("hac-agentic-system").setSubject("fixture-user").setIssuedAt().setExpirationTime("5m").sign(issuerKeys.privateKey)
      return res.end(JSON.stringify({ id_token: idToken }))
    } catch { res.statusCode = 400; return res.end('{"error":"invalid_grant"}') }
  }
  res.statusCode = 404; res.end("{}")
})
after(() => { server.close(); rmSync(directory, { recursive: true, force: true }) })
async function begin() {
  const response = await beginLogin()
  const redirect = new URL(response.headers.get("location")!)
  nonce = redirect.searchParams.get("nonce")!
  challenge = redirect.searchParams.get("code_challenge")!
  const cookie = response.headers.get("set-cookie")!.split(";")[0]
  const callback = `http://localhost:3003/api/auth/callback?code=${randomBytes(16).toString("hex")}&state=${redirect.searchParams.get("state")}`
  return new Request(callback, { headers: { cookie } })
}
test("OIDC uses PKCE and private_key_jwt, verifies signed identity, and consumes login state once", async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  process.env.OIDC_ISSUER = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const request = await begin()
  const response = await finishLogin(request)
  assert.equal(response.status, 302)
  assert.ok(assertionVerified)
  const cookie = response.headers.getSetCookie().find(c => c.startsWith("hac_session="))!.split(";")[0]
  assert.equal(principalFor(new Request("http://localhost:3003", { headers: { cookie } }))?.provider, "oidc")
  await assert.rejects(() => finishLogin(request), /expired or was already used/)
})
test("a validly signed ID token with the wrong nonce cannot establish identity", async () => {
  tokenNonce = "wrong-nonce"
  const request = await begin()
  await assert.rejects(() => finishLogin(request), /Identity proof did not match/)
})
test("hosted login verifies FreeID proof and persists identity without a local database", async () => {
  tokenNonce = ""
  process.env.VERCEL = "1"
  process.env.HAC_SESSION_SECRET = randomBytes(32).toString("hex")
  process.env.HAC_DATA_DIR = "/unwritable-hac-test"
  const request = await begin()
  const response = await finishLogin(request)
  assert.equal(response.headers.get("location"), "http://localhost:3003/workspace")
  const cookie = response.headers.getSetCookie().find(c => c.startsWith("hac_session="))!.split(";")[0]
  const sessionRequest = new Request("http://localhost:3003", { headers: { cookie } })
  assert.equal(principalFor(sessionRequest)?.provider, "oidc")
  const tampered = Buffer.from(cookie.split("=")[1], "base64url"); tampered[0] ^= 1
  assert.equal(principalFor(new Request("http://localhost:3003", { headers: { cookie: `hac_session=${tampered.toString("base64url")}` } })), null)
  assert.match(logout(sessionRequest), /Max-Age=0/)
  // Reusing an old encrypted transaction cannot exchange an already-used code.
  await assert.rejects(() => finishLogin(request), /rejected the token exchange/)
  const mismatched = new URL(request.url); mismatched.searchParams.set("state", "forged")
  await assert.rejects(() => finishLogin(new Request(mismatched, { headers: request.headers })), /Invalid sign-in response/)
})
