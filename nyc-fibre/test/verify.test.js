// Verification of FreeID passport releases: an SD-JWT VC presentation with a
// key-binding JWT, encrypted to NYC Fibre as a compact ECDH-ES JWE.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPair } from 'jose'
import { verifyRelease } from '../api/_verify.js'
import { LICENCE_SOURCE_LABEL } from '../api/_verify.js'
import {
  CLIENT_ID,
  FIELDS,
  ISSUER,
  LICENCE_FIELDS,
  LICENCE_VERIFICATION,
  NONCE,
  NOW,
  buildRelease,
  disclosure,
  issuerJwks,
  k,
  nowSeconds,
} from './fixtures.js'

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

test('a passport/v1 release verifies and returns the released fields', async () => {
  const result = await verify(await buildRelease())
  assert.deepEqual(result.fields, FIELDS)
  assert.equal(result.verification.passive_authentication, true)
  assert.equal(result.verification.csca_chain, true)
  assert.equal(result.verification.app_attest, true)
  assert.deepEqual(result.holderKey, { kty: 'OKP', crv: 'Ed25519', x: k.holderPublic.x })
  assert.equal(result.vct, 'https://free-id.org/vct/passport/v1')
  assert.equal(result.licence, null)
  assert.equal(result.address, null)
})

test('a release with the full document number verifies', async () => {
  const result = await verify(await buildRelease({ fields: { document_number: 'K1234123Z' } }), {
    fullNumberRequested: true,
  })
  assert.equal(result.fields.document_number, 'K1234123Z')
})

test('a full document number that was not requested is rejected', async () => {
  await assert.rejects(verify(await buildRelease({ fields: { document_number: 'K1234123Z' } })), {
    message: "Release includes a field that wasn't requested",
  })
})

for (const name of ['given_name', 'family_name', 'birthdate', 'passport_expiry']) {
  test(`a release without ${name} is rejected`, async () => {
    await assert.rejects(verify(await buildRelease({ omit: [name] })), {
      message: 'Release is missing required details',
    })
  })
}

test('a release with no disclosures at all is rejected', async () => {
  await assert.rejects(verify(await buildRelease({ omit: Object.keys(FIELDS) })), {
    message: 'Release is missing required details',
  })
})

test('nationality and the masked number are optional', async () => {
  const result = await verify(await buildRelease({ omit: ['nationality', 'document_number_masked'] }))
  assert.equal(result.fields.nationality, undefined)
})

for (const check of ['passive_authentication', 'csca_chain', 'app_attest']) {
  test(`a credential with ${check} not true is rejected`, async () => {
    await assert.rejects(verify(await buildRelease({ verification: { [check]: false } })), {
      message: 'Passport chip not verified',
    })
  })
}

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

// identity/v1: passport fields nested under `passport`, an optional NYS licence
// container among three top-level digests.

test('an identity/v1 passport-only release verifies, with no address', async () => {
  const result = await verify(await buildRelease({ identity: true }))
  assert.equal(result.vct, 'https://free-id.org/vct/identity/v1')
  assert.deepEqual(result.fields, FIELDS)
  assert.equal(result.verification.passive_authentication, true)
  assert.equal(result.licence, null)
  assert.equal(result.address, null)
})

test('an identity/v1 release with an enrolled but undisclosed licence looks the same as none', async () => {
  const result = await verify(await buildRelease({ identity: true, licence: { disclose: [] } }))
  assert.deepEqual(result.fields, FIELDS)
  assert.equal(result.licence, null)
  assert.equal(result.address, null)
})

test('an identity/v1 release with the licence address returns it with its source label', async () => {
  const result = await verify(
    await buildRelease({ identity: true, licence: { fields: { address: LICENCE_FIELDS.address } } }),
  )
  assert.deepEqual(result.fields, FIELDS)
  assert.deepEqual(result.address, {
    value: LICENCE_FIELDS.address,
    source: 'nys_licence',
    label: "From NYS driver's licence barcode — not verified by New York State",
  })
  assert.equal(result.address.label, LICENCE_SOURCE_LABEL)
  assert.deepEqual(result.licence.verification, LICENCE_VERIFICATION)
  assert.equal(result.licence.verification.issuer_signature, false)
})

test('an identity/v1 release with several licence fields verifies them all', async () => {
  const result = await verify(await buildRelease({ identity: true, licence: {} }))
  assert.deepEqual(result.licence.fields, LICENCE_FIELDS)
  assert.deepEqual(result.address.value, LICENCE_FIELDS.address)
})

test('an address with only some members is accepted', async () => {
  const address = { locality: 'New York', region: 'NY' }
  const result = await verify(await buildRelease({ identity: true, licence: { fields: { address } } }))
  assert.deepEqual(result.address.value, address)
})

test('a licence container with no address disclosed returns no address', async () => {
  const result = await verify(
    await buildRelease({ identity: true, licence: { disclose: [], showContainer: true } }),
  )
  assert.deepEqual(result.fields, FIELDS)
  assert.deepEqual(result.licence, { verification: LICENCE_VERIFICATION, fields: {} })
  assert.equal(result.address, null)
})

test('a licence container with other fields but not the address returns no address', async () => {
  const result = await verify(
    await buildRelease({ identity: true, licence: { disclose: ['given_name', 'family_name'] } }),
  )
  assert.deepEqual(result.licence.fields, { given_name: 'ALEX', family_name: 'MORGAN' })
  assert.equal(result.address, null)
})

test('identity/v1 still requires the passport fields', async () => {
  await assert.rejects(verify(await buildRelease({ identity: true, licence: {}, omit: ['birthdate'] })), {
    message: 'Release is missing required details',
  })
})

test('identity/v1 still checks the passport verification block', async () => {
  await assert.rejects(verify(await buildRelease({ identity: true, verification: { csca_chain: false } })), {
    message: 'Passport chip not verified',
  })
})

test('identity/v1 still checks the key binding', async () => {
  await assert.rejects(verify(await buildRelease({ identity: true, licence: {}, nonce: 'other' })), {
    message: 'Presentation does not match this sign-in',
  })
})

test('a dropped licence disclosure breaks the sd_hash', async () => {
  const jwe = await buildRelease({
    identity: true,
    licence: {},
    presented: (issuerJwt, disclosures, kbJwt) =>
      [issuerJwt, ...disclosures.slice(0, -1).map((d) => d.encoded)].join('~') + '~' + kbJwt,
  })
  await assert.rejects(verify(jwe), { message: 'Presentation was altered' })
})

test('a forged licence address disclosure is rejected', async () => {
  const jwe = await buildRelease({
    identity: true,
    licence: {},
    presented: (issuerJwt, disclosures) => {
      const forged = disclosure('address', { ...LICENCE_FIELDS.address, street_address: '9 Elsewhere Rd' })
      const parts = disclosures.map((d) => (d.name === 'address' ? forged.encoded : d.encoded))
      return [issuerJwt, ...parts].join('~') + '~kb.placeholder.sig'
    },
  })
  await assert.rejects(verify(jwe), { message: 'Disclosure not signed by FreeID' })
})

test('a licence address without its container is rejected', async () => {
  // The address digest sits inside the container, so without the container it matches nothing signed.
  const jwe = await buildRelease({
    identity: true,
    licence: {},
    presented: (issuerJwt, disclosures) =>
      [issuerJwt, ...disclosures.filter((d) => d.name !== 'nys_licence').map((d) => d.encoded)].join('~') +
      '~kb.placeholder.sig',
  })
  await assert.rejects(verify(jwe), { message: 'Disclosure not signed by FreeID' })
})

test('a forged licence container is rejected', async () => {
  const jwe = await buildRelease({
    identity: true,
    licence: {},
    presented: (issuerJwt, disclosures) => {
      const address = disclosure('address', { locality: 'Anywhere' })
      const forged = disclosure('nys_licence', { verification: LICENCE_VERIFICATION, _sd: [address.digest] })
      return [issuerJwt, ...disclosures.slice(0, 6).map((d) => d.encoded), forged.encoded, address.encoded].join('~') +
        '~kb.placeholder.sig'
    },
  })
  await assert.rejects(verify(jwe), { message: 'Disclosure not signed by FreeID' })
})

test('a passport/v1 release carrying a licence disclosure is rejected', async () => {
  const jwe = await buildRelease({
    presented: (issuerJwt, disclosures) => {
      const address = disclosure('address', LICENCE_FIELDS.address)
      return [issuerJwt, ...disclosures.map((d) => d.encoded), address.encoded].join('~') + '~kb.placeholder.sig'
    },
  })
  await assert.rejects(verify(jwe), { message: 'Disclosure not signed by FreeID' })
})

test('a duplicated licence disclosure is rejected', async () => {
  const jwe = await buildRelease({
    identity: true,
    licence: {},
    presented: (issuerJwt, disclosures) => {
      const parts = [...disclosures.map((d) => d.encoded), disclosures[disclosures.length - 1].encoded]
      return [issuerJwt, ...parts].join('~') + '~kb.placeholder.sig'
    },
  })
  await assert.rejects(verify(jwe), { message: 'Duplicate disclosure' })
})

for (const [label, address] of [
  ['a string', '1 Main St, New York, NY 10044'],
  ['an array', ['1 Main St', 'New York']],
  ['an object with a non-string member', { street_address: '1 Main St', postal_code: 10044 }],
  ['an object with a nested object', { street_address: { line1: '1 Main St' } }],
  ['an object with an unknown member', { street_address: '1 Main St', county: 'New York' }],
  ['an empty object', {}],
  ['null', null],
]) {
  test(`a licence address that is ${label} is rejected`, async () => {
    await assert.rejects(verify(await buildRelease({ identity: true, licence: { fields: { address } } })), {
      message: 'Malformed disclosure',
    })
  })
}

test('a passport field with a non-string value is rejected', async () => {
  await assert.rejects(verify(await buildRelease({ identity: true, fields: { given_name: ['Alex'] } })), {
    message: 'Malformed disclosure',
  })
})

test('a licence date field that is not a calendar date is rejected', async () => {
  await assert.rejects(
    verify(await buildRelease({ identity: true, licence: { fields: { under_21_until: '2019-02-30' } } })),
    { message: 'Malformed disclosure' },
  )
})

test('an unknown licence field is rejected', async () => {
  await assert.rejects(verify(await buildRelease({ identity: true, licence: { fields: { eye_colour: 'BRO' } } })), {
    message: 'Unexpected field',
  })
})

test('the full licence number is rejected because NYC Fibre never asks for it', async () => {
  await assert.rejects(
    verify(await buildRelease({ identity: true, licence: { fields: { licence_number: '123456789' } } })),
    { message: "Release includes a field that wasn't requested" },
  )
})

for (const [label, verification] of [
  ['claims an issuer signature', { issuer_signature: true }],
  ['names another source', { source: 'mdoc' }],
  ['has no holder match', { holder_match: 'none' }],
  ['has a malformed valid_until', { valid_until: '14/03/2030' }],
]) {
  test(`a licence container that ${label} is rejected`, async () => {
    await assert.rejects(verify(await buildRelease({ identity: true, licence: { verification } })), {
      message: 'Malformed disclosure',
    })
  })
}

test('a licence container with extra members is rejected', async () => {
  const container = { verification: LICENCE_VERIFICATION, _sd: [], note: 'x' }
  await assert.rejects(
    verify(await buildRelease({ identity: true, licence: { container, disclose: [], showContainer: true } })),
    { message: 'Malformed disclosure' },
  )
})

test('an expired licence is rejected', async () => {
  await assert.rejects(
    verify(await buildRelease({ identity: true, licence: { verification: { valid_until: '2026-10-15' } } })),
    { message: 'Licence has expired' },
  )
})

test('a signed top-level disclosure other than the licence container is rejected', async () => {
  // FreeID never puts anything but nys_licence among the top-level digests.
  const jwe = await buildRelease({ identity: true, extraTopLevel: [disclosure('address', LICENCE_FIELDS.address)] })
  await assert.rejects(verify(jwe), { message: 'Unexpected field' })
})

test('two signed top-level disclosures are rejected', async () => {
  const jwe = await buildRelease({
    identity: true,
    licence: {},
    extraTopLevel: [disclosure('nys_licence', { verification: LICENCE_VERIFICATION, _sd: [] })],
  })
  await assert.rejects(verify(jwe), { message: 'Duplicate disclosure' })
})

test('an identity/v1 credential without exactly three top-level digests is rejected', async () => {
  await assert.rejects(verify(await buildRelease({ identity: true, topLevelCount: 2 })), {
    message: 'Not a FreeID passport credential',
  })
})
