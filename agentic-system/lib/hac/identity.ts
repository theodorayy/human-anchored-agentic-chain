import { createHash, randomBytes } from "node:crypto"
import { createRemoteJWKSet, jwtVerify } from "jose"
import { verifyRelease } from "../freeid/verify-release.js"
import { appUrl } from "./auth"
import { HttpError } from "./control-plane"
import { clientAssertion, discovery } from "./oidc"
import { transaction } from "./store"
import type { Principal, State } from "./types"
import { placeholdersFromRelease, storeVault, vaultKeys } from "./vault"

// Sisyphus's own FreeID release: the holder approves on their phone, the verified values
// go into the task's vault, and the agent only ever learns the placeholder names.

export const RELEASE_SCOPES = ["openid", "passport", "passport:name", "passport:birthdate", "passport:nationality",
  "passport:expiry", "passport:number_masked", "licence", "licence:address"].join(" ")
const ATTEMPT_MS = 600_000

export function identityStatus(state: State, mandateId: string): "none" | "pending" | "ready" {
  if (vaultKeys(state, mandateId).length) return "ready"
  return (state.identityRequests || []).some(r => r.mandateId === mandateId) ? "pending" : "none"
}

export function requestIdentity(state: State, principalId: string, mandateId: string):
  { status: "ready"; placeholders: string[] } | { status: "pending" } {
  const mandate = state.mandates.find(m => m.id === mandateId && m.principalId === principalId)
  if (!mandate || mandate.revokedAt) throw new Error("This task has no active permissions.")
  const keys = vaultKeys(state, mandateId)
  if (keys.length) return { status: "ready", placeholders: keys.map(k => `{${k}}`) }
  state.identityRequests = state.identityRequests || []
  if (!state.identityRequests.some(r => r.mandateId === mandateId))
    state.identityRequests.push({ mandateId, principalId, requestedAt: new Date().toISOString() })
  return { status: "pending" }
}

export async function beginRelease(principal: Principal, mandateId: string) {
  const config = await discovery()
  const state = randomBytes(24).toString("base64url"), nonce = randomBytes(24).toString("base64url"), verifier = randomBytes(32).toString("base64url")
  transaction(db => {
    const request = (db.identityRequests || []).find(r => r.mandateId === mandateId && r.principalId === principal.id)
    if (!request) throw new HttpError(404, "No FreeID request is waiting for this task.")
    request.attempt = { state, nonce, verifier, expiresAt: Date.now() + ATTEMPT_MS }
  })
  const url = new URL(config.authorization_endpoint)
  url.search = new URLSearchParams({ client_id: process.env.OIDC_CLIENT_ID!, response_type: "code", scope: RELEASE_SCOPES,
    redirect_uri: `${appUrl()}/api/freeid/callback`, state, nonce,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString()
  return new Response(null, { status: 302, headers: { location: url.toString(), "cache-control": "no-store" } })
}

const back = (outcome: "ready" | "failed") =>
  new Response(null, { status: 302, headers: { location: `${appUrl()}/workspace?identity=${outcome}`, "cache-control": "no-store" } })

export async function finishRelease(request: Request, principal: Principal) {
  try {
    const url = new URL(request.url), state = url.searchParams.get("state"), code = url.searchParams.get("code")
    if (!state || !code) throw new Error("Missing code or state")
    // Single use: the attempt is cleared before any network call.
    const pending = transaction(db => {
      const entry = (db.identityRequests || []).find(r => r.attempt?.state === state && r.principalId === principal.id)
      if (!entry?.attempt || entry.attempt.expiresAt <= Date.now()) return null
      const attempt = entry.attempt
      delete entry.attempt
      return { mandateId: entry.mandateId, attempt }
    })
    if (!pending) throw new Error("Unknown or expired FreeID request")
    const config = await discovery(), clientId = process.env.OIDC_CLIENT_ID!
    const body = new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId,
      redirect_uri: `${appUrl()}/api/freeid/callback`, code_verifier: pending.attempt.verifier,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: await clientAssertion(config.token_endpoint) })
    const token = await fetch(config.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(30_000) })
    if (!token.ok) throw new Error(`Token exchange failed (${token.status})`)
    const tokens = await token.json() as { id_token?: string; access_token?: string }
    if (!tokens.id_token || !tokens.access_token) throw new Error("Token response incomplete")
    const keys = createRemoteJWKSet(new URL(config.jwks_uri))
    const { payload } = await jwtVerify(tokens.id_token, keys, { issuer: config.issuer, audience: clientId, algorithms: ["ES256"], requiredClaims: ["sub", "exp", "iat"] })
    if (payload.nonce !== pending.attempt.nonce) throw new Error("ID token nonce mismatch")
    if (!Array.isArray(payload.amr) || !payload.amr.includes("nansen")) throw new Error("ID token is not a passport release")
    const releaser = createHash("sha256").update(`${config.issuer}\0${payload.sub}`).digest("hex")
    if (releaser !== principal.id) throw new Error("Release came from a different account than the signed-in one")
    const info = await fetch(config.userinfo_endpoint, { headers: { authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(30_000) })
    if (!info.ok || !(info.headers.get("content-type") || "").startsWith("application/jwt")) throw new Error(`Userinfo returned ${info.status}`)
    const release = await verifyRelease({ jwe: await info.text(), encPrivateJwk: JSON.parse(process.env.OIDC_ENC_PRIVATE_JWK || "{}"),
      issuerJwks: keys, issuer: config.issuer, clientId, nonce: pending.attempt.nonce })
    transaction(db => {
      const mandate = db.mandates.find(m => m.id === pending.mandateId && m.principalId === principal.id && !m.revokedAt)
      if (!mandate) throw new Error("The task's permissions ended before the release arrived")
      storeVault(db, mandate, placeholdersFromRelease(release, release.presentation))
      db.identityRequests = (db.identityRequests || []).filter(r => r.mandateId !== mandate.id)
    })
    return back("ready")
  } catch (error) {
    // Messages above and from verifyRelease never contain released values.
    console.error("FreeID release failed:", error instanceof Error ? error.message : "Unknown error")
    return back("failed")
  }
}
