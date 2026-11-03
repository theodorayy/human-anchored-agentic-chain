// Test fixtures: throwaway FreeID, holder and door-check keys, and a builder for
// synthetic FreeID releases, adapted from NYC Fibre's. The credential is
// identity/v1 by default (passport/v1 with `passportV1: true`); its passport
// field digests are always signed, but no passport disclosure is presented
// unless a test asks (`presentPassport`). `passportFlags` signs passport age
// flags into the passport block and presents them; `licence` enrols an NYS licence.
import { createHash, randomBytes } from 'node:crypto'
import { CompactEncrypt, SignJWT, exportJWK, generateKeyPair } from 'jose'

export const ISSUER = 'https://api.free-id.org'
export const CLIENT_ID = 'nyc-age-verif-bar'
export const NONCE = 'nonce-from-the-oidc-request'
// Noon in New York.
export const NOW = new Date('2026-10-16T16:00:00Z')
export const TODAY = '2026-10-16'
export const nowSeconds = Math.floor(NOW.getTime() / 1000)

const b64url = (text) => Buffer.from(text, 'utf8').toString('base64url')
export const sha256 = (ascii) => createHash('sha256').update(ascii, 'ascii').digest('base64url')

async function keys() {
  const freeid = await generateKeyPair('ES256', { extractable: true })
  const other = await generateKeyPair('ES256', { extractable: true })
  const holder = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true })
  const enc = await generateKeyPair('ECDH-ES', { crv: 'P-256', extractable: true })
  const otherEnc = await generateKeyPair('ECDH-ES', { crv: 'P-256', extractable: true })
  const sig = await generateKeyPair('ES256', { extractable: true })
  const freeidPublic = { ...(await exportJWK(freeid.publicKey)), kid: 'freeid-1', alg: 'ES256', use: 'sig' }
  const holderPublic = await exportJWK(holder.publicKey)
  const encPrivate = { ...(await exportJWK(enc.privateKey)), kid: 'nyc-age-verif-bar-enc-1' }
  const otherEncPrivate = { ...(await exportJWK(otherEnc.privateKey)), kid: 'nyc-age-verif-bar-enc-1' }
  const sigPrivate = await exportJWK(sig.privateKey)
  return { freeid, other, holder, enc, freeidPublic, holderPublic, encPrivate, otherEncPrivate, sigPrivate }
}

export const k = await keys()
export const issuerJwks = { keys: [k.freeidPublic] }

// Signed into every credential; presented only when a test says so.
export const PASSPORT_FIELDS = {
  given_name: 'Alex',
  family_name: 'Morgan',
  birthdate: '1998-03-14',
  nationality: 'SGP',
  passport_expiry: '2031-04-03',
  document_number_masked: '••••••123Z',
}

// A 28-year-old: every flag in the past. Used for both the passport and the licence flags.
export const AGE_FLAGS = {
  under_18_until: '2016-03-14',
  under_19_until: '2017-03-14',
  under_21_until: '2019-03-14',
}

export const LICENCE_VERIFICATION = {
  source: 'aamva_pdf417',
  issuer_signature: false,
  holder_match: 'passport',
  expiry_check: 'valid',
  valid_until: '2030-03-14',
}

const decoy = () => sha256(randomBytes(32).toString('base64url'))

export function disclosure(name, value) {
  const encoded = b64url(JSON.stringify([randomBytes(16).toString('base64url'), name, value]))
  return { name, value, encoded, digest: sha256(encoded) }
}

/** Shifts an ISO date by whole days. */
export function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/**
 * Builds a release; `tweak` hooks let each test break exactly one thing.
 * `passportFlags`: age flags signed into the passport block (identity/v1) or,
 * with `passportV1`, into the flat passport/v1 digests; `disclosePassportFlags`
 * lists those presented (default: all).
 * `licence`: `{ fields, verification, disclose, showContainer, container }`, where
 * `fields` are the licence fields enrolled (default: the age flags), `disclose`
 * lists those presented (default: all) and the container is presented when any
 * field is, or when `showContainer` is set. `presentPassport` lists signed
 * passport fields to present. `extraTopLevel` signs and presents further
 * top-level disclosures.
 */
export async function buildRelease(tweak = {}) {
  const passportDisclosures = Object.entries({ ...PASSPORT_FIELDS, ...(tweak.passportFields || {}) }).map(
    ([name, value]) => disclosure(name, value),
  )
  const passportFlagDisclosures = Object.entries(tweak.passportFlags || {}).map(([name, value]) =>
    disclosure(name, value),
  )
  const iat = tweak.now ? Math.floor(tweak.now.getTime() / 1000) : nowSeconds
  const verification = {
    passive_authentication: true,
    csca_chain: true,
    liveness: 'blink',
    face_match: 'matched',
    app_attest: true,
    ...(tweak.verification || {}),
  }
  const passportDigests = [...passportDisclosures, ...passportFlagDisclosures].map((d) => d.digest).sort()
  const presentedDisclosures = passportDisclosures.filter((d) => (tweak.presentPassport || []).includes(d.name))
  const disclosePassportFlags = tweak.disclosePassportFlags || passportFlagDisclosures.map((d) => d.name)
  presentedDisclosures.push(...passportFlagDisclosures.filter((d) => disclosePassportFlags.includes(d.name)))

  let claims
  if (tweak.passportV1) {
    claims = {
      vct: 'https://free-id.org/vct/passport/v1',
      _sd_alg: 'sha-256',
      _sd: passportDigests,
      cnf: { jwk: { kty: 'OKP', crv: 'Ed25519', x: k.holderPublic.x } },
      verification,
    }
  } else {
    const topLevel = []
    const licence = tweak.licence
    if (licence) {
      const licenceDisclosures = Object.entries(licence.fields || AGE_FLAGS).map(([name, value]) =>
        disclosure(name, value),
      )
      const container = disclosure(
        'nys_licence',
        licence.container || {
          verification: { ...LICENCE_VERIFICATION, ...(licence.verification || {}) },
          _sd: licenceDisclosures.map((d) => d.digest).sort(),
        },
      )
      topLevel.push(container.digest)
      const disclose = licence.disclose || licenceDisclosures.map((d) => d.name)
      const chosen = licenceDisclosures.filter((d) => disclose.includes(d.name))
      if (chosen.length > 0 || licence.showContainer) presentedDisclosures.push(container, ...chosen)
    }
    for (const extra of tweak.extraTopLevel || []) {
      topLevel.push(extra.digest)
      presentedDisclosures.push(extra)
    }
    while (topLevel.length < (tweak.topLevelCount ?? 3)) topLevel.push(decoy())
    claims = {
      vct: 'https://free-id.org/vct/identity/v1',
      _sd_alg: 'sha-256',
      cnf: { jwk: { kty: 'OKP', crv: 'Ed25519', x: k.holderPublic.x } },
      passport: { verification, _sd: passportDigests },
      _sd: topLevel.sort(),
    }
  }

  const issuerJwt = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', typ: tweak.issuerTyp || 'dc+sd-jwt', kid: 'freeid-1' })
    .setIssuer(tweak.iss || ISSUER)
    .setIssuedAt(iat - 86400)
    .sign(tweak.issuerKey || k.freeid.privateKey)

  const sdJwt = [issuerJwt, ...presentedDisclosures.map((d) => d.encoded)].join('~') + '~'
  const kbJwt = await new SignJWT({
    aud: tweak.aud || CLIENT_ID,
    nonce: tweak.nonce || NONCE,
    iat: tweak.iat ?? iat - 10,
    sd_hash: sha256(sdJwt),
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'kb+jwt' })
    .sign(tweak.holderKey || k.holder.privateKey)

  const presented = tweak.presented ? tweak.presented(issuerJwt, presentedDisclosures, kbJwt) : `${sdJwt}${kbJwt}`
  return new CompactEncrypt(new TextEncoder().encode(presented))
    .setProtectedHeader({ alg: 'ECDH-ES', enc: 'A256GCM', cty: 'dc+sd-jwt', kid: 'nyc-age-verif-bar-enc-1' })
    .encrypt(k.enc.publicKey)
}
