// Verifies a FreeID release: a compact JWE (ECDH-ES, A256GCM) whose plaintext
// is an SD-JWT VC presentation `issuerJwt~d1~…~dN~kbJwt`. Two credential types:
//   passport/v1  flat: passport field digests in the top-level `_sd`.
//   identity/v1  nested: passport field digests in `passport._sd`; the top-level
//                `_sd` holds 3 digests, at most one of them the selectively
//                disclosable `nys_licence` container, whose own `_sd` holds the
//                licence field digests.
// Every failure throws an Error whose message is safe to show the user; no
// message ever contains a released value.
import { createHash } from 'node:crypto'
import { compactDecrypt, createLocalJWKSet, importJWK, jwtVerify } from 'jose'

export const PASSPORT_VCT = 'https://free-id.org/vct/passport/v1'
export const IDENTITY_VCT = 'https://free-id.org/vct/identity/v1'
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

// Licence fields inside the `nys_licence` container (identity/v1 only).
const LICENCE_STRING_FIELDS = [
  'given_name',
  'middle_name',
  'family_name',
  'name_suffix',
  'licence_number_masked',
]
const LICENCE_DATE_FIELDS = ['birthdate', 'under_18_until', 'under_19_until', 'under_21_until']
export const LICENCE_FIELDS = ['address', ...LICENCE_STRING_FIELDS, ...LICENCE_DATE_FIELDS, 'licence_number']
const ADDRESS_MEMBERS = ['street_address', 'locality', 'region', 'postal_code', 'country']
const LICENCE_CONTAINER = 'nys_licence'
const TOP_LEVEL_DIGESTS = 3
const MAX_LICENCE_DIGESTS = 16
// The licence barcode carries no issuer signature; this is how NYC Fibre labels anything taken from it.
export const LICENCE_SOURCE_LABEL = "From NYS driver's licence barcode — not verified by New York State"

const MAX_AGE_SECONDS = 5 * 60
const MAX_SKEW_SECONDS = 60
const BASE64URL = /^[A-Za-z0-9_-]+$/
const DIGEST = /^[A-Za-z0-9_-]{43}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

const sha256 = (ascii) => createHash('sha256').update(ascii, 'ascii').digest('base64url')
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isCalendarDate = (value) =>
  typeof value === 'string' && DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value

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
    (payload.vct !== PASSPORT_VCT && payload.vct !== IDENTITY_VCT) ||
    payload._sd_alg !== 'sha-256' ||
    !jwk ||
    jwk.kty !== 'OKP' ||
    jwk.crv !== 'Ed25519' ||
    typeof jwk.x !== 'string'
  ) {
    fail('Not a FreeID passport credential')
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
    fail('Not a FreeID passport credential')
  }
  // FreeID only issues after an attested on-device passport check; anything less is refused.
  const checks = passport.verification
  if (
    !checks ||
    typeof checks !== 'object' ||
    checks.passive_authentication !== true ||
    checks.csca_chain !== true ||
    checks.app_attest !== true
  ) {
    fail('Passport chip not verified')
  }
  return {
    payload,
    nested,
    verification: checks,
    passportDigests: passport._sd,
    topLevelDigests: nested ? payload._sd : [],
  }
}

function isDigestList(list) {
  return (
    Array.isArray(list) &&
    list.every((digest) => typeof digest === 'string' && DIGEST.test(digest)) &&
    new Set(list).size === list.length
  )
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

function readPassportFields(disclosures) {
  const fields = {}
  for (const { name, value } of disclosures) {
    if (!KNOWN_FIELDS.includes(name)) fail('Unexpected field')
    if (Object.hasOwn(fields, name)) fail('Duplicate disclosure')
    if (typeof value !== 'string') fail('Malformed disclosure')
    fields[name] = value
  }
  return fields
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

function readAddress(value) {
  if (!isRecord(value)) fail('Malformed disclosure')
  const entries = Object.entries(value)
  if (
    entries.length === 0 ||
    entries.some(([member, part]) => !ADDRESS_MEMBERS.includes(member) || typeof part !== 'string')
  ) {
    fail('Malformed disclosure')
  }
  return Object.fromEntries(ADDRESS_MEMBERS.filter((member) => Object.hasOwn(value, member)).map((m) => [m, value[m]]))
}

function readLicenceFields(disclosures) {
  const fields = {}
  for (const { name, value } of disclosures) {
    if (!LICENCE_FIELDS.includes(name)) fail('Unexpected field')
    if (Object.hasOwn(fields, name)) fail('Duplicate disclosure')
    if (name === 'address') fields.address = readAddress(value)
    else if (LICENCE_DATE_FIELDS.includes(name)) {
      if (!isCalendarDate(value)) fail('Malformed disclosure')
      fields[name] = value
    } else {
      if (typeof value !== 'string') fail('Malformed disclosure')
      fields[name] = value
    }
  }
  // NYC Fibre never asks for the full licence number.
  if (fields.licence_number !== undefined) fail("Release includes a field that wasn't requested")
  return fields
}

/**
 * Resolves every disclosure against the digests FreeID signed. Disclosures that
 * match no digest (or a digest at the wrong level) are refused.
 */
function readDisclosures(encodedList, credential, today) {
  const byDigest = parseDisclosures(encodedList)
  const fields = readPassportFields(take(byDigest, credential.passportDigests))

  let licence = null
  const containers = take(byDigest, credential.topLevelDigests)
  if (containers.length > 1) fail('Duplicate disclosure')
  if (containers.length === 1) {
    const [{ name, value }] = containers
    if (name !== LICENCE_CONTAINER) fail('Unexpected field')
    const { verification, digests } = readLicenceContainer(value, today)
    licence = { verification, fields: readLicenceFields(take(byDigest, digests)) }
  }

  if (byDigest.size > 0) fail('Disclosure not signed by FreeID')
  return { fields, licence }
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
 * `fields` are the passport fields (flat, whichever credential type); `licence`
 * is the disclosed `nys_licence` container, if any; `address` is the licence
 * address with its source label, or null.
 * @returns {Promise<{ vct: string, fields: Record<string, string>, verification: object,
 *   licence: { verification: object, fields: object } | null,
 *   address: { value: Record<string, string>, source: string, label: string } | null,
 *   holderKey: object }>}
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
  const today = at.toISOString().slice(0, 10)
  const { fields, licence } = readDisclosures(disclosures, credential, today)
  const holderKey = { kty: 'OKP', crv: 'Ed25519', x: credential.payload.cnf.jwk.x }
  const sdJwt = presentation.slice(0, presentation.length - kbJwt.length)
  await verifyKeyBinding(kbJwt, holderKey, { sdJwt, clientId, nonce, now: at })

  if (REQUIRED_FIELDS.some((name) => fields[name] === undefined)) fail('Release is missing required details')
  if (fields.document_number !== undefined && !fullNumberRequested) {
    fail("Release includes a field that wasn't requested")
  }
  if (!DATE.test(fields.passport_expiry)) fail('Malformed disclosure')
  if (fields.passport_expiry < today) fail('Passport has expired')

  // Optional: absent when the holder declined it or has no licence enrolled (the two look the same).
  const address = licence?.fields.address
    ? { value: licence.fields.address, source: LICENCE_CONTAINER, label: LICENCE_SOURCE_LABEL }
    : null

  return {
    vct: credential.payload.vct,
    fields,
    verification: credential.verification,
    licence,
    address,
    holderKey,
  }
}

