// Verification of FreeID passport releases: an SD-JWT VC presentation with a
// key-binding JWT, encrypted to NYC Fibre as a compact ECDH-ES JWE.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPair } from 'jose'
import { verifyRelease } from '../api/verify.js'
import { CLIENT_ID, FIELDS, ISSUER, NONCE, NOW, buildRelease, disclosure, issuerJwks, k, nowSeconds } from './fixtures.js'

const verify = (jwe, overrides = {}) =>
  verifyRelease({
    jwe,
    encPrivateJwk: k.encPrivate,
    issuerJwks,
    issuer: ISSUER,
    clientId: CLIENT_ID,
    nonce: NONCE,
    now: NOW,
    ...overrides,
  })

test('a valid release verifies and returns the released fields', async () => {
  const result = await verify(await buildRelease())
  assert.deepEqual(result.fields, FIELDS)
  assert.equal(result.verification.passive_authentication, true)
  assert.equal(result.verification.csca_chain, true)
  assert.equal(result.verification.app_attest, true)
  assert.deepEqual(result.holderKey, { kty: 'OKP', crv: 'Ed25519', x: k.holderPublic.x })
})

test('a release with the full document number verifies', async () => {
  const result = await verify(await buildRelease({ fields: { document_number: 'K1234123Z' } }))
  assert.equal(result.fields.document_number, 'K1234123Z')
})

test('a tampered disclosure is rejected', async () => {
  const jwe = await buildRelease({
    presented: (issuerJwt, disclosures) => {
      const forged = disclosure('given_name', 'Mallory')
      const parts = disclosures.map((d) => (d.name === 'given_name' ? forged.encoded : d.encoded))
      const sdJwt = [issuerJwt, ...parts].join('~') + '~'
      return sdJwt + 'kb.placeholder.sig'
    },
  })
  await assert.rejects(verify(jwe), { message: 'Disclosure not signed by FreeID' })
})

test('a presentation for another service is rejected', async () => {
  await assert.rejects(verify(await buildRelease({ aud: 'another-isp' })), {
    message: 'Presentation is for another service',
  })
})

test('a presentation with another nonce is rejected', async () => {
  await assert.rejects(verify(await buildRelease({ nonce: 'some-other-nonce' })), {
    message: 'Presentation does not match this sign-in',
  })
})

test('an sd_hash mismatch is rejected', async () => {
  // The holder signed over one disclosure set; a disclosure was then dropped.
  const jwe = await buildRelease({
    presented: (issuerJwt, disclosures, kbJwt) =>
      [issuerJwt, ...disclosures.slice(1).map((d) => d.encoded)].join('~') + '~' + kbJwt,
  })
  await assert.rejects(verify(jwe), { message: 'Presentation was altered' })
})

test('an issuer JWT signed by another key is rejected', async () => {
  await assert.rejects(verify(await buildRelease({ issuerKey: k.other.privateKey })), {
    message: 'Not issued by FreeID',
  })
})

test('an issuer JWT from another issuer is rejected', async () => {
  await assert.rejects(verify(await buildRelease({ iss: 'https://evil.example' })), {
    message: 'Not issued by FreeID',
  })
})

test('an issuer JWT with the wrong typ is rejected', async () => {
  await assert.rejects(verify(await buildRelease({ issuerTyp: 'JWT' })), {
    message: 'Not issued by FreeID',
  })
})

test('an expired passport is rejected', async () => {
  await assert.rejects(verify(await buildRelease({ fields: { passport_expiry: '2026-10-15' } })), {
    message: 'Passport has expired',
  })
})

test('a passport expiring today is still valid', async () => {
  const result = await verify(await buildRelease({ fields: { passport_expiry: '2026-10-16' } }))
  assert.equal(result.fields.passport_expiry, '2026-10-16')
})

test('a release encrypted to another key is rejected', async () => {
  await assert.rejects(verify(await buildRelease(), { encPrivateJwk: k.otherEncPrivate }), {
    message: 'Could not decrypt the release',
  })
})

test('a garbled JWE is rejected', async () => {
  await assert.rejects(verify('not-a-jwe'), { message: 'Could not decrypt the release' })
})

test('a key-binding JWT signed by another holder key is rejected', async () => {
  const intruder = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true })
  await assert.rejects(verify(await buildRelease({ holderKey: intruder.privateKey })), {
    message: 'Holder key binding failed',
  })
})

test('a presentation older than five minutes is rejected', async () => {
  await assert.rejects(verify(await buildRelease({ iat: nowSeconds - 301 })), {
    message: 'Presentation is stale',
  })
})

test('a presentation dated more than a minute ahead is rejected', async () => {
  await assert.rejects(verify(await buildRelease({ iat: nowSeconds + 61 })), {
    message: 'Presentation is stale',
  })
})

test('a duplicated disclosure is rejected', async () => {
  const jwe = await buildRelease({
    presented: (issuerJwt, disclosures) => {
      const parts = [...disclosures.map((d) => d.encoded), disclosures[0].encoded]
      return [issuerJwt, ...parts].join('~') + '~kb.placeholder.sig'
    },
  })
  await assert.rejects(verify(jwe), { message: 'Duplicate disclosure' })
})

test('a signed disclosure for an unknown field is rejected', async () => {
  await assert.rejects(verify(await buildRelease({ fields: { photo: 'base64-photo' } })), {
    message: 'Unexpected field',
  })
})

test('a presentation without a key-binding JWT is rejected', async () => {
  const jwe = await buildRelease({
    presented: (issuerJwt, disclosures) => [issuerJwt, ...disclosures.map((d) => d.encoded)].join('~') + '~',
  })
  await assert.rejects(verify(jwe), { message: 'Malformed release' })
})

test('a remote-style key resolver is accepted for the issuer keys', async () => {
  const { createLocalJWKSet } = await import('jose')
  const result = await verify(await buildRelease(), { issuerJwks: createLocalJWKSet(issuerJwks) })
  assert.equal(result.fields.family_name, 'Morgan')
})
