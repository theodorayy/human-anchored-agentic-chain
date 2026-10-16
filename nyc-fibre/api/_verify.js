// Verifies a FreeID passport release: a compact JWE (ECDH-ES, A256GCM) whose
// plaintext is an SD-JWT VC presentation `issuerJwt~d1~…~dN~kbJwt`.
// Every failure throws an Error whose message is safe to show the user; no
// message ever contains a released value.
import { createHash } from 'node:crypto'
import { compactDecrypt, createLocalJWKSet, importJWK, jwtVerify } from 'jose'

export const PASSPORT_VCT = 'https://free-id.org/vct/passport/v1'
export const KNOWN_FIELDS = [
  'given_name',
  'family_name',
  'birthdate',
  'nationality',
  'passport_expiry',
  'document_number_masked',
  'document_number',
]
// Every release must carry these; the full number only when it was asked for.
export const REQUIRED_FIELDS = ['given_name', 'family_name', 'birthdate', 'passport_expiry']
const MAX_AGE_SECONDS = 5 * 60
const MAX_SKEW_SECONDS = 60
const BASE64URL = /^[A-Za-z0-9_-]+$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

const sha256 = (ascii) => createHash('sha256').update(ascii, 'ascii').digest('base64url')

function fail(message) {
  throw new Error(message)
}

async function decrypt(jwe, encPrivateJwk) {
  try {
    const { kty, crv, x, y, d, kid } = encPrivateJwk
    const key = await importJWK({ kty, crv, x, y, d }, 'ECDH-ES')
    const { plaintext, protectedHeader } = await compactDecrypt(String(jwe).trim(), key, {
      keyManagementAlgorithms: ['ECDH-ES'],
      contentEncryptionAlgorithms: ['A256GCM'],
    })
    if (protectedHeader.cty !== 'dc+sd-jwt') throw new Error('unexpected content type')
    if (kid && protectedHeader.kid && protectedHeader.kid !== kid) throw new Error('unexpected key')
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
  } catch {
    return fail('Could not decrypt the release')
  }
}

async function verifyIssuerJwt(issuerJwt, issuerJwks, issuer, now) {
  const keySet = typeof issuerJwks === 'function' ? issuerJwks : createLocalJWKSet(issuerJwks)
  let payload
  try {
    ;({ payload } = await jwtVerify(issuerJwt, keySet, {
      issuer,
      typ: 'dc+sd-jwt',
      algorithms: ['ES256'],
      currentDate: now,
    }))
  } catch {
    return fail('Not issued by FreeID')
  }
  const jwk = payload.cnf?.jwk
  if (
    payload.vct !== PASSPORT_VCT ||
    payload._sd_alg !== 'sha-256' ||
    !Array.isArray(payload._sd) ||
    !jwk ||
    jwk.kty !== 'OKP' ||
    jwk.crv !== 'Ed25519' ||
    typeof jwk.x !== 'string'
  ) {
    fail('Not a FreeID passport credential')
  }
  // FreeID only issues after an attested on-device passport check; anything less is refused.
  const checks = payload.verification
  if (
    !checks ||
    typeof checks !== 'object' ||
    checks.passive_authentication !== true ||
    checks.csca_chain !== true ||
    checks.app_attest !== true
  ) {
    fail('Passport chip not verified')
  }
  return payload
}

function readDisclosures(encodedList, signedDigests) {
  const signed = new Set(signedDigests)
  const seen = new Set()
  const fields = {}
  for (const encoded of encodedList) {
    if (!BASE64URL.test(encoded)) fail('Malformed disclosure')
    if (seen.has(encoded)) fail('Duplicate disclosure')
    seen.add(encoded)
    if (!signed.has(sha256(encoded))) fail('Disclosure not signed by FreeID')

    let parsed
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded, 'base64url')))
    } catch {
      fail('Malformed disclosure')
    }
    if (!Array.isArray(parsed) || parsed.length !== 3 || !parsed.every((part) => typeof part === 'string')) {
      fail('Malformed disclosure')
    }
    const [, name, value] = parsed
    if (!KNOWN_FIELDS.includes(name)) fail('Unexpected field')
    if (Object.hasOwn(fields, name)) fail('Duplicate disclosure')
    fields[name] = value
  }
  return fields
}

async function verifyKeyBinding(kbJwt, holderJwk, { sdJwt, clientId, nonce, now }) {
  let payload
  try {
    const key = await importJWK({ kty: holderJwk.kty, crv: holderJwk.crv, x: holderJwk.x }, 'EdDSA')
    ;({ payload } = await jwtVerify(kbJwt, key, { typ: 'kb+jwt', algorithms: ['EdDSA'], currentDate: now }))
  } catch {
    return fail('Holder key binding failed')
  }
  if (payload.aud !== clientId) fail('Presentation is for another service')
  if (typeof nonce !== 'string' || !nonce || payload.nonce !== nonce) {
    fail('Presentation does not match this sign-in')
  }
  const nowSeconds = Math.floor(now.getTime() / 1000)
  if (
    typeof payload.iat !== 'number' ||
    nowSeconds - payload.iat > MAX_AGE_SECONDS ||
    payload.iat - nowSeconds > MAX_SKEW_SECONDS
  ) {
    fail('Presentation is stale')
  }
  if (payload.sd_hash !== sha256(sdJwt)) fail('Presentation was altered')
}

/**
 * `fullNumberRequested`: whether this sign-in asked for `passport:number`.
 * @returns {Promise<{ fields: Record<string, string>, verification: object, holderKey: object }>}
 */
export async function verifyRelease({
  jwe,
  encPrivateJwk,
  issuerJwks,
  issuer,
  clientId,
  nonce,
  fullNumberRequested = false,
  now = new Date(),
}) {
  const at = now instanceof Date ? now : new Date(now)
  const presentation = await decrypt(jwe, encPrivateJwk)

  const parts = presentation.split('~')
  const issuerJwt = parts[0]
  const kbJwt = parts[parts.length - 1]
  const disclosures = parts.slice(1, -1)
  if (parts.length < 2 || !issuerJwt || !kbJwt || disclosures.some((d) => !d)) fail('Malformed release')

  const credential = await verifyIssuerJwt(issuerJwt, issuerJwks, issuer, at)
  const fields = readDisclosures(disclosures, credential._sd)
  const holderKey = { kty: 'OKP', crv: 'Ed25519', x: credential.cnf.jwk.x }
  const sdJwt = presentation.slice(0, presentation.length - kbJwt.length)
  await verifyKeyBinding(kbJwt, holderKey, { sdJwt, clientId, nonce, now: at })

  if (REQUIRED_FIELDS.some((name) => fields[name] === undefined)) fail('Release is missing required details')
  if (fields.document_number !== undefined && !fullNumberRequested) {
    fail("Release includes a field that wasn't requested")
  }
  if (!DATE.test(fields.passport_expiry)) fail('Malformed disclosure')
  if (fields.passport_expiry < at.toISOString().slice(0, 10)) fail('Passport has expired')

  return { fields, verification: credential.verification, holderKey }
}

