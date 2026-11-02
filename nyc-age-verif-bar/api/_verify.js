// Verifies a FreeID release for the door check: a compact JWE (ECDH-ES, A256GCM)
// whose plaintext is an SD-JWT VC presentation `issuerJwt~d1~…~dN~kbJwt`.
// Trimmed from NYC Fibre's verifier. The door asks only for the licence age
// flags (`licence:age_flags`), so the only disclosures it accepts are:
//   - the `nys_licence` container (identity/v1, one of the 3 top-level digests),
//   - inside it, `under_18_until`, `under_19_until` and `under_21_until`.
// Any passport field or other licence field, even one FreeID signed, is refused:
// the door never asked for it and must not receive it.
// passport/v1 credentials (no licence possible) still verify, with no licence.
// Every failure throws an Error whose message is safe to show; no message ever
// contains a released value.
import { createHash } from 'node:crypto'
import { compactDecrypt, createLocalJWKSet, importJWK, jwtVerify } from 'jose'

export const PASSPORT_VCT = 'https://free-id.org/vct/passport/v1'
export const IDENTITY_VCT = 'https://free-id.org/vct/identity/v1'
// The age flags: the date the holder turns 18, 19 and 21 (AAMVA DDH, DDI, DDJ).
export const AGE_FLAGS = ['under_18_until', 'under_19_until', 'under_21_until']
// Everything else FreeID can disclose; signed or not, the door refuses it.
const PASSPORT_FIELDS = [
  'given_name',
  'family_name',
  'birthdate',
  'nationality',
  'passport_expiry',
  'document_number_masked',
  'document_number',
]
const OTHER_LICENCE_FIELDS = [
  'address',
  'given_name',
  'middle_name',
  'family_name',
  'name_suffix',
  'birthdate',
  'licence_number',
  'licence_number_masked',
]
const LICENCE_CONTAINER = 'nys_licence'
const TOP_LEVEL_DIGESTS = 3
const MAX_LICENCE_DIGESTS = 16
// The licence barcode carries no issuer signature; this is how the door labels any answer taken from it.
export const LICENCE_SOURCE_LABEL = 'Age from NYS licence barcode — not verified by New York State'

const MAX_AGE_SECONDS = 5 * 60
const MAX_SKEW_SECONDS = 60
const BASE64URL = /^[A-Za-z0-9_-]+$/
const DIGEST = /^[A-Za-z0-9_-]{43}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

const sha256 = (ascii) => createHash('sha256').update(ascii, 'ascii').digest('base64url')
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isCalendarDate = (value) =>
  typeof value === 'string' && DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value

/** The calendar date (YYYY-MM-DD) at `date` in `timeZone`. */
export function localDate(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

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

function isDigestList(list) {
  return (
    Array.isArray(list) &&
    list.every((digest) => typeof digest === 'string' && DIGEST.test(digest)) &&
    new Set(list).size === list.length
  )
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
    (payload.vct !== PASSPORT_VCT && payload.vct !== IDENTITY_VCT) ||
    payload._sd_alg !== 'sha-256' ||
    !jwk ||
    jwk.kty !== 'OKP' ||
    jwk.crv !== 'Ed25519' ||
    typeof jwk.x !== 'string'
  ) {
    fail('Not a FreeID credential')
  }
  const nested = payload.vct === IDENTITY_VCT
  // passport/v1 keeps the passport block at the top level; identity/v1 nests it under `passport`.
  const passport = nested ? payload.passport : payload
  if (
    !isRecord(passport) ||
    !isDigestList(passport._sd) ||
    (nested && (!isDigestList(payload._sd) || payload._sd.length !== TOP_LEVEL_DIGESTS)) ||
    (nested && Object.hasOwn(payload, LICENCE_CONTAINER))
  ) {
    fail('Not a FreeID credential')
  }
  // The licence is bound to a passport holder (`holder_match: "passport"`), and
  // FreeID only issues after an attested on-device passport check.
  const checks = passport.verification
  if (
    !isRecord(checks) ||
    checks.passive_authentication !== true ||
    checks.csca_chain !== true ||
    checks.app_attest !== true
  ) {
    fail('Passport chip not verified')
  }
  return {
    payload,
    passportDigests: passport._sd,
    topLevelDigests: nested ? payload._sd : [],
  }
}

/** Decodes each disclosure once and indexes it by its digest. */
function parseDisclosures(encodedList) {
  const byDigest = new Map()
  for (const encoded of encodedList) {
    if (!BASE64URL.test(encoded)) fail('Malformed disclosure')
    const digest = sha256(encoded)
    if (byDigest.has(digest)) fail('Duplicate disclosure')

    let parsed
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded, 'base64url')))
    } catch {
      fail('Malformed disclosure')
    }
    // Object-property disclosures only: [salt, name, value].
    if (!Array.isArray(parsed) || parsed.length !== 3 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') {
      fail('Malformed disclosure')
    }
    byDigest.set(digest, { name: parsed[1], value: parsed[2] })
  }
  return byDigest
}

/** Takes the disclosures whose digests `digests` lists, so each can be used once. */
function take(byDigest, digests) {
  const found = []
  for (const digest of digests) {
    const disclosure = byDigest.get(digest)
    if (!disclosure) continue
    byDigest.delete(digest)
    found.push(disclosure)
  }
  return found
}

/** The container's `verification` must say exactly what FreeID's phone writes: unsigned barcode data. */
function readLicenceContainer(value, today) {
  if (!isRecord(value) || Object.keys(value).sort().join() !== '_sd,verification') fail('Malformed disclosure')
  const { verification, _sd: digests } = value
  if (
    !isRecord(verification) ||
    Object.keys(verification).sort().join() !== 'expiry_check,holder_match,issuer_signature,source,valid_until' ||
    verification.source !== 'aamva_pdf417' ||
    verification.issuer_signature !== false ||
    verification.holder_match !== 'passport' ||
    verification.expiry_check !== 'valid' ||
    !isCalendarDate(verification.valid_until)
  ) {
    fail('Malformed disclosure')
  }
  if (!isDigestList(digests) || digests.length < 1 || digests.length > MAX_LICENCE_DIGESTS) {
    fail('Malformed disclosure')
  }
  if (verification.valid_until < today) fail('Licence has expired')
  return { verification, digests }
}

function readAgeFlags(disclosures) {
  const flags = {}
  for (const { name, value } of disclosures) {
    if (OTHER_LICENCE_FIELDS.includes(name)) fail("Release includes a field that wasn't requested")
    if (!AGE_FLAGS.includes(name)) fail('Unexpected field')
    if (Object.hasOwn(flags, name)) fail('Duplicate disclosure')
    if (!isCalendarDate(value)) fail('Malformed disclosure')
    flags[name] = value
  }
  return flags
}

/**
 * Resolves every disclosure against the digests FreeID signed. Signed passport
 * fields and non-age licence fields are refused as unrequested; disclosures that
 * match no digest (or a digest at the wrong level) are refused as unsigned.
 */
function readDisclosures(encodedList, credential, today) {
  const byDigest = parseDisclosures(encodedList)
  for (const { name } of take(byDigest, credential.passportDigests)) {
    fail(PASSPORT_FIELDS.includes(name) ? "Release includes a field that wasn't requested" : 'Unexpected field')
  }

  let licence = null
  const containers = take(byDigest, credential.topLevelDigests)
  if (containers.length > 1) fail('Duplicate disclosure')
  if (containers.length === 1) {
    const [{ name, value }] = containers
    if (name !== LICENCE_CONTAINER) fail('Unexpected field')
    const { verification, digests } = readLicenceContainer(value, today)
    licence = { verification, flags: readAgeFlags(take(byDigest, digests)) }
  }

  if (byDigest.size > 0) fail('Disclosure not signed by FreeID')
  return licence
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
 * `licence` is the disclosed `nys_licence` container with its age flags, or
 * null when none was disclosed (no licence enrolled, or the guest declined it:
 * the two look the same). `today` is the local date the checks used.
 * @returns {Promise<{ vct: string, today: string,
 *   licence: { verification: object, flags: Record<string, string> } | null }>}
 */
export async function verifyRelease({
  jwe,
  encPrivateJwk,
  issuerJwks,
  issuer,
  clientId,
  nonce,
  timeZone = 'America/New_York',
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
  const today = localDate(at, timeZone)
  const licence = readDisclosures(disclosures, credential, today)
  const holderKey = { kty: 'OKP', crv: 'Ed25519', x: credential.payload.cnf.jwk.x }
  const sdJwt = presentation.slice(0, presentation.length - kbJwt.length)
  await verifyKeyBinding(kbJwt, holderKey, { sdJwt, clientId, nonce, now: at })

  return { vct: credential.payload.vct, today, licence }
}

/**
 * The door's answer for threshold `min` (18 or 21): 'yes' once today has reached
 * the date in `under_<min>_until` (the birthday itself counts), 'no' before it,
 * and 'unknown' when that flag (or the whole licence) wasn't disclosed.
 * Never 'yes' without the flag.
 */
export function decide(licence, min, today) {
  const until = licence?.flags?.[`under_${min}_until`]
  if (!until) return 'unknown'
  return today >= until ? 'yes' : 'no'
}
