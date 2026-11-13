import { createHash, randomBytes } from "node:crypto"
import { createRemoteJWKSet, importJWK, jwtVerify, SignJWT } from "jose"
import { appUrl, cookieHeader, createSession, oidcAvailable, readCookie } from "./auth"
import { HttpError } from "./control-plane"
import { transaction } from "./store"
import { sealedSessions } from "./deployment"
import { openCookie, sealCookie } from "./sealed-cookie"

type LoginAttempt = { state: string; nonce: string; verifier: string; expiresAt: number }

export async function discovery() {
  if (!oidcAvailable()) throw new HttpError(503, "Configure OIDC_ISSUER and OIDC_CLIENT_ID to connect an identity provider.")
  const issuer = process.env.OIDC_ISSUER!
  // FreeID may need to wake from Fly's idle state before serving discovery.
  const response = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new HttpError(502, "Identity provider discovery failed.")
  const data = await response.json()
  if (data.issuer !== issuer) throw new HttpError(502, "Identity provider issuer mismatch.")
  return data as { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; userinfo_endpoint: string }
}
// private_key_jwt (RFC 7523): FreeID expects aud = token endpoint.
export async function clientAssertion(tokenEndpoint: string) {
  const clientId = process.env.OIDC_CLIENT_ID!
  const key = await importJWK(JSON.parse(process.env.OIDC_CLIENT_PRIVATE_JWK!), "ES256")
  return new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: "hac-rp" }).setIssuer(clientId).setSubject(clientId)
    .setAudience(tokenEndpoint).setIssuedAt().setExpirationTime("2m").setJti(randomBytes(16).toString("hex")).sign(key)
}
export async function beginLogin() {
  const config = await discovery()
  const state = randomBytes(32).toString("hex"), nonce = randomBytes(32).toString("hex"), verifier = randomBytes(32).toString("base64url")
  const attempt = { state, nonce, verifier, expiresAt: Date.now() + 600_000 }
  if (!sealedSessions()) transaction(db => {
    db.oauth = db.oauth.filter(o => o.expiresAt > Date.now())
    db.oauth.push(attempt)
  })
  const url = new URL(config.authorization_endpoint)
  url.search = new URLSearchParams({ client_id: process.env.OIDC_CLIENT_ID!, response_type: "code",
    scope: "openid profile email", redirect_uri: `${appUrl()}/api/auth/callback`, state, nonce,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString()
  const token = sealedSessions() ? sealCookie("oidc", attempt, 600) : state
  return new Response(null, { status: 302, headers: { location: url.toString(), "set-cookie": cookieHeader("hac_oidc", token, 600), "cache-control": "no-store" } })
}
export async function finishLogin(request: Request) {
  const url = new URL(request.url), state = url.searchParams.get("state"), code = url.searchParams.get("code")
  const cookie = readCookie(request, "hac_oidc")
  const sealedAttempt = sealedSessions() ? openCookie<LoginAttempt>("oidc", cookie) : null
  if (!state || !code || state !== (sealedSessions() ? sealedAttempt?.state : cookie)) throw new HttpError(400, "Invalid sign-in response. Please try again.")
  const attempt = sealedSessions() ? sealedAttempt : transaction(db => {
    const entry = db.oauth.find(o => o.state === state && o.expiresAt > Date.now())
    db.oauth = db.oauth.filter(o => o.state !== state)
    return entry
  })
  if (!attempt || attempt.expiresAt <= Date.now()) throw new HttpError(400, "Sign-in expired or was already used.")
  const config = await discovery(), clientId = process.env.OIDC_CLIENT_ID!
  const body = new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId,
    redirect_uri: `${appUrl()}/api/auth/callback`, code_verifier: attempt.verifier })
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" }
  if (process.env.OIDC_CLIENT_PRIVATE_JWK) {
    body.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer")
    body.set("client_assertion", await clientAssertion(config.token_endpoint))
  } else if (process.env.OIDC_CLIENT_SECRET) {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(process.env.OIDC_CLIENT_SECRET)}`).toString("base64")}`
  }
  const response = await fetch(config.token_endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new HttpError(502, "Identity provider rejected the token exchange.")
  const tokens = await response.json()
  const { payload } = await jwtVerify(tokens.id_token, createRemoteJWKSet(new URL(config.jwks_uri)), {
    issuer: config.issuer, audience: clientId, algorithms: ["RS256", "ES256"], requiredClaims: ["sub", "exp", "iat", "nonce"],
  })
  if (payload.nonce !== attempt.nonce || !payload.sub || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) throw new HttpError(400, "Identity proof did not match this sign-in.")
  const principal = { id: createHash("sha256").update(`${config.issuer}\0${payload.sub}`).digest("hex"),
    name: String(payload.name || payload.email || "Authenticated principal"), provider: "oidc" as const }
  const result = new Response(null, { status: 302, headers: { location: `${appUrl()}/workspace`, "cache-control": "no-store" } })
  result.headers.append("set-cookie", createSession(principal))
  result.headers.append("set-cookie", cookieHeader("hac_oidc", "", 0))
  return result
}
