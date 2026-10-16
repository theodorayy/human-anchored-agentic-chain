// Shared helpers for NYC Fibre's FreeID relying-party functions.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { importJWK, SignJWT } from 'jose'

export const ISSUER = process.env.FREEID_ISSUER || 'https://api.free-id.org'
export const CLIENT_ID = process.env.FREEID_CLIENT_ID || 'nyc-fibre'
export const APP_URL = process.env.APP_URL || 'https://nyc-fibre.vercel.app'
export const REDIRECT_URI = `${APP_URL}/api/callback`
export const KEY_ID = 'nyc-fibre-1'
const COOKIE = 'nyf_freeid'

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

export function privateJwk() {
  const raw = process.env.NYF_PRIVATE_JWK
  if (!raw) throw new Error('NYF_PRIVATE_JWK is not configured')
  return JSON.parse(raw)
}

export function publicJwk() {
  const { kty, crv, x, y } = privateJwk()
  return { kty, crv, x, y, kid: KEY_ID, use: 'sig', alg: 'ES256' }
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

// Tamper-proof cookie: base64url(JSON) + HMAC. Holds only flow state, no personal data.
function secret() {
  const value = process.env.COOKIE_SECRET
  if (!value) throw new Error('COOKIE_SECRET is not configured')
  return value
}
const sign = (data) => createHmac('sha256', secret()).update(data).digest('base64url')

export function sealCookie(value, maxAgeSeconds) {
  const data = Buffer.from(JSON.stringify({ ...value, exp: Date.now() + maxAgeSeconds * 1000 })).toString('base64url')
  return `${COOKIE}=${data}.${sign(data)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

export function openCookie(req) {
  const header = req.headers.cookie || ''
  const match = header.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))
  if (!match) return null
  const [data, mac] = match.slice(COOKIE.length + 1).split('.')
  if (!data || !mac) return null
  const expected = Buffer.from(sign(data))
  const given = Buffer.from(mac)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  const value = JSON.parse(Buffer.from(data, 'base64url').toString())
  return value.exp > Date.now() ? value : null
}

export function redirect(res, location, cookie) {
  if (cookie) res.setHeader('set-cookie', cookie)
  res.setHeader('cache-control', 'no-store')
  res.statusCode = 302
  res.setHeader('location', location)
  res.end()
}
