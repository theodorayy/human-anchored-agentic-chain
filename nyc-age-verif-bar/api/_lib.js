// Shared helpers for the NYC age-verification bar door check's relying-party functions.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { importJWK, SignJWT } from 'jose'

export const ISSUER = process.env.FREEID_ISSUER || 'https://api.free-id.org'
export const CLIENT_ID = process.env.FREEID_CLIENT_ID || 'nyc-age-verif-bar'
export const APP_URL = process.env.APP_URL || 'https://nyc-age-verif-bar.vercel.app'
export const REDIRECT_URI = `${APP_URL}/api/callback`
// The door is in New York: "today" is the local calendar date there, not UTC's.
export const TIME_ZONE = process.env.BAR_TIME_ZONE || 'America/New_York'
export const KEY_ID = 'nyc-age-verif-bar-1'
export const ENC_KEY_ID = 'nyc-age-verif-bar-enc-1'
// Flow state (state, nonce, PKCE verifier, threshold) and the decision use separate cookies.
export const FLOW_COOKIE = 'bar_freeid'
export const RESULT_COOKIE = 'bar_result'
export const RESULT_COOKIE_PATH = '/api/result'

// The only age thresholds the door checks; each maps to one licence age flag.
export const THRESHOLDS = [18, 21]

// Failures reach the page as short codes only; the page maps each to fixed copy,
// so nothing from the URL is ever rendered.
export const REASON_CODES = [
  'declined', // the guest chose not to share
  'expired', // flow cookie missing, expired or state mismatch
  'signin', // token exchange or ID token failed
  'unavailable', // FreeID unreachable or no release returned
  'decrypt', // release not encrypted to our key
  'issuer', // not issued by FreeID / not a FreeID credential
  'chip', // passport chip or app attestation not verified
  'binding', // key binding: holder key, audience, nonce, freshness, sd_hash
  'fields', // unexpected, unrequested, duplicate, forged or malformed fields
  'licence_expired', // the licence in the credential has expired
  'threshold', // the check was started without 18 or 21
  'error', // anything else
]

export function failureLocation(code) {
  return `/?freeid=error&reason=${REASON_CODES.includes(code) ? code : 'error'}`
}

// Only the licence's age flags: never a name, a date of birth or a passport field.
export const SCOPES = 'openid licence licence:age_flags'

let discoveryCache
export async function discovery() {
  if (discoveryCache) return discoveryCache
  // FreeID may need to wake from Fly's idle state.
  const res = await fetch(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error('FreeID discovery failed')
  const data = await res.json()
  if (data.issuer !== ISSUER) throw new Error('FreeID issuer mismatch')
  discoveryCache = data
  return data
}

function readJwk(name) {
  const raw = process.env[name]
  if (!raw) throw new Error(`${name} is not configured`)
  const { kty, crv, x, y, d } = JSON.parse(raw)
  if (kty !== 'EC' || crv !== 'P-256' || !x || !y || !d) throw new Error(`${name} must be a private P-256 JWK`)
  return { kty, crv, x, y, d }
}

/** P-256 signing key for client assertions (kid nyc-age-verif-bar-1). */
export function privateJwk() {
  return readJwk('BAR_PRIVATE_JWK')
}

/** P-256 key FreeID releases are encrypted to (kid nyc-age-verif-bar-enc-1). */
export function encPrivateJwk() {
  return { ...readJwk('BAR_ENC_PRIVATE_JWK'), kid: ENC_KEY_ID }
}

/** Both public keys: one to verify our client assertions, one to encrypt releases to. */
export function publicJwks() {
  const sig = privateJwk()
  const enc = encPrivateJwk()
  return {
    keys: [
      { kty: sig.kty, crv: sig.crv, x: sig.x, y: sig.y, kid: KEY_ID, use: 'sig', alg: 'ES256' },
      { kty: enc.kty, crv: enc.crv, x: enc.x, y: enc.y, kid: ENC_KEY_ID, use: 'enc', alg: 'ECDH-ES' },
    ],
  }
}

/** private_key_jwt client assertion (RFC 7523); FreeID expects aud = token endpoint. */
export async function clientAssertion() {
  const { token_endpoint } = await discovery()
  const key = await importJWK(privateJwk(), 'ES256')
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: KEY_ID })
    .setIssuer(CLIENT_ID)
    .setSubject(CLIENT_ID)
    .setAudience(token_endpoint)
    .setIssuedAt()
    .setExpirationTime('2m')
    .setJti(randomBytes(16).toString('hex'))
    .sign(key)
}

export async function postForm(url, params) {
  const body = new URLSearchParams({
    ...params,
    client_id: CLIENT_ID,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: await clientAssertion(),
  })
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { ok: res.ok, status: res.status, json }
}

// Tamper-proof cookies: base64url(JSON) + HMAC, HttpOnly. The flow cookie holds
// only flow state; the result cookie holds, for two minutes until the page reads
// it once, the threshold and the decision (yes / no / unknown). Never a value.
function secret() {
  const value = process.env.COOKIE_SECRET
  if (!value) throw new Error('COOKIE_SECRET is not configured')
  return value
}
const sign = (name, data) => createHmac('sha256', secret()).update(`${name}.${data}`).digest('base64url')

export function sealCookie(name, value, maxAgeSeconds, path = '/') {
  const data = Buffer.from(JSON.stringify({ ...value, exp: Date.now() + maxAgeSeconds * 1000 })).toString('base64url')
  return `${name}=${data}.${sign(name, data)}; Path=${path}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`
}

export function clearCookie(name, path = '/') {
  return `${name}=; Path=${path}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

export function openCookie(req, name) {
  const header = req.headers.cookie || ''
  const match = header.split(/;\s*/).find((c) => c.startsWith(`${name}=`))
  if (!match) return null
  const [data, mac] = match.slice(name.length + 1).split('.')
  if (!data || !mac) return null
  const expected = Buffer.from(sign(name, data))
  const given = Buffer.from(mac)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  try {
    const value = JSON.parse(Buffer.from(data, 'base64url').toString())
    return value.exp > Date.now() ? value : null
  } catch {
    return null
  }
}

export function redirect(res, location, cookies) {
  if (cookies) res.setHeader('set-cookie', cookies)
  res.setHeader('cache-control', 'no-store')
  res.statusCode = 302
  res.setHeader('location', location)
  res.end()
}
