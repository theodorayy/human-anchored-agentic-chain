// Test fixtures: throwaway FreeID, holder and NYC Fibre keys, and a builder for
// FreeID passport releases with hooks to break exactly one thing at a time.
import { createHash, randomBytes } from 'node:crypto'
import { CompactEncrypt, SignJWT, exportJWK, generateKeyPair } from 'jose'

export const ISSUER = 'https://api.free-id.org'
export const CLIENT_ID = 'nyc-fibre'
export const NONCE = 'nonce-from-the-oidc-request'
export const NOW = new Date('2026-10-16T12:00:00Z')
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
  const encPrivate = { ...(await exportJWK(enc.privateKey)), kid: 'nyc-fibre-enc-1' }
  const otherEncPrivate = { ...(await exportJWK(otherEnc.privateKey)), kid: 'nyc-fibre-enc-1' }
  const sigPrivate = await exportJWK(sig.privateKey)
  return { freeid, other, holder, enc, freeidPublic, holderPublic, encPrivate, otherEncPrivate, sigPrivate }
}

export const k = await keys()
export const issuerJwks = { keys: [k.freeidPublic] }

export const FIELDS = {
  given_name: 'Alex',
  family_name: 'Morgan',
  birthdate: '1998-03-14',
  nationality: 'SGP',
  passport_expiry: '2031-04-03',
  document_number_masked: '••••••123Z',
}

export function disclosure(name, value) {
  const encoded = b64url(JSON.stringify([randomBytes(16).toString('base64url'), name, value]))
  return { name, value, encoded, digest: sha256(encoded) }
}

/** Builds a release; `tweak` hooks let each test break exactly one thing. */
export async function buildRelease(tweak = {}) {
  const fields = { ...FIELDS, ...(tweak.fields || {}) }
  const disclosures = Object.entries(fields).map(([name, value]) => disclosure(name, value))
  const iat = tweak.now ? Math.floor(tweak.now.getTime() / 1000) : nowSeconds

  const issuerJwt = await new SignJWT({
    vct: 'https://free-id.org/vct/passport/v1',
    _sd_alg: 'sha-256',
    _sd: disclosures.map((d) => d.digest).sort(),
    cnf: { jwk: { kty: 'OKP', crv: 'Ed25519', x: k.holderPublic.x } },
    verification: {
      passive_authentication: true,
      csca_chain: true,
      liveness: 'blink',
      face_match: 'not_performed',
      app_attest: true,
    },
  })
    .setProtectedHeader({ alg: 'ES256', typ: tweak.issuerTyp || 'dc+sd-jwt', kid: 'freeid-1' })
    .setIssuer(tweak.iss || ISSUER)
    .setIssuedAt(iat - 86400)
    .sign(tweak.issuerKey || k.freeid.privateKey)

  const sdJwt = [issuerJwt, ...disclosures.map((d) => d.encoded)].join('~') + '~'
  const kbJwt = await new SignJWT({
    aud: tweak.aud || CLIENT_ID,
    nonce: tweak.nonce || NONCE,
    iat: tweak.iat ?? iat - 10,
    sd_hash: sha256(sdJwt),
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'kb+jwt' })
    .sign(tweak.holderKey || k.holder.privateKey)

  const presented = tweak.presented ? tweak.presented(issuerJwt, disclosures, kbJwt) : `${sdJwt}${kbJwt}`
  return new CompactEncrypt(new TextEncoder().encode(presented))
    .setProtectedHeader({ alg: 'ECDH-ES', enc: 'A256GCM', cty: 'dc+sd-jwt', kid: 'nyc-fibre-enc-1' })
    .encrypt(k.enc.publicKey)
}
