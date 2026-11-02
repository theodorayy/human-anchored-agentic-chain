// Verification of FreeID age-flag releases and the door's decision, with
// synthetic credentials.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPair } from 'jose'
import { decide, localDate, verifyRelease } from '../api/_verify.js'
import {
  AGE_FLAGS,
  CLIENT_ID,
  ISSUER,
  LICENCE_VERIFICATION,
  NONCE,
  NOW,
  TODAY,
  addDays,
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

async function decisionFor(min, tweak = {}, overrides = {}) {
  const release = await verify(await buildRelease(tweak), overrides)
  return decide(release.licence, min, release.today)
}

const flagsWith = (min, date) => ({ ...AGE_FLAGS, [`under_${min}_until`]: date })

// The decision: today >= under_N_until → YES; before → NO; no flag → CAN'T CONFIRM.

for (const min of [18, 21]) {
  test(`${min}+: a guest whose ${min}th birthday has passed is YES`, async () => {
    assert.equal(await decisionFor(min, { licence: { fields: flagsWith(min, addDays(TODAY, -1)) } }), 'yes')
  })

  test(`${min}+: a guest whose ${min}th birthday is today is YES`, async () => {
    assert.equal(await decisionFor(min, { licence: { fields: flagsWith(min, TODAY) } }), 'yes')
  })

  test(`${min}+: a guest whose ${min}th birthday is tomorrow is NO`, async () => {
    assert.equal(await decisionFor(min, { licence: { fields: flagsWith(min, addDays(TODAY, 1)) } }), 'no')
  })

  test(`${min}+: a licence without the under_${min}_until flag is CAN'T CONFIRM`, async () => {
    const fields = { ...AGE_FLAGS }
    delete fields[`under_${min}_until`]
    assert.equal(await decisionFor(min, { licence: { fields } }), 'unknown')
  })

  test(`${min}+: a release with no licence at all is CAN'T CONFIRM`, async () => {
    assert.equal(await decisionFor(min), 'unknown')
  })

  test(`${min}+: an enrolled licence the guest didn't share is CAN'T CONFIRM`, async () => {
    assert.equal(await decisionFor(min, { licence: { disclose: [] } }), 'unknown')
  })

  test(`${min}+: a licence container with no flags is CAN'T CONFIRM`, async () => {
    assert.equal(await decisionFor(min, { licence: { disclose: [], showContainer: true } }), 'unknown')
  })

  test(`${min}+: a passport/v1 credential (no licence possible) is CAN'T CONFIRM`, async () => {
    assert.equal(await decisionFor(min, { passportV1: true }), 'unknown')
  })
}

test('a 19-year-old is YES at 18+ and NO at 21+ from the same release', async () => {
  const fields = { under_18_until: addDays(TODAY, -400), under_19_until: addDays(TODAY, -35), under_21_until: addDays(TODAY, 695) }
  const release = await verify(await buildRelease({ licence: { fields } }))
  assert.equal(decide(release.licence, 18, release.today), 'yes')
  assert.equal(decide(release.licence, 21, release.today), 'no')
})

test('only the requested flag decides: under_18 alone cannot answer 21+', async () => {
  const fields = { under_18_until: '2010-01-01' }
  assert.equal(await decisionFor(18, { licence: { fields } }), 'yes')
  assert.equal(await decisionFor(21, { licence: { fields } }), 'unknown')
})

test('"today" is the New York date, not UTC: 22:00 the night before a 21st is still NO', async () => {
  // 02:00 UTC on 17 Oct is 22:00 on 16 Oct in New York.
  const lateEvening = new Date('2026-10-17T02:00:00Z')
  const tweak = { now: lateEvening, licence: { fields: flagsWith(21, '2026-10-17') } }
  assert.equal(await decisionFor(21, tweak, { now: lateEvening }), 'no')
  // 05:00 UTC on 17 Oct is 01:00 on 17 Oct in New York.
  const afterMidnight = new Date('2026-10-17T05:00:00Z')
  const later = { now: afterMidnight, licence: { fields: flagsWith(21, '2026-10-17') } }
  assert.equal(await decisionFor(21, later, { now: afterMidnight }), 'yes')
})

test('localDate reads the calendar date in the given zone', () => {
  assert.equal(localDate(new Date('2026-10-17T02:00:00Z'), 'America/New_York'), '2026-10-16')
  assert.equal(localDate(new Date('2026-10-17T02:00:00Z'), 'UTC'), '2026-10-17')
})

test('decide never says YES without the flag, and only knows 18 and 21', () => {
  assert.equal(decide(null, 18, TODAY), 'unknown')
  assert.equal(decide({ flags: {} }, 21, TODAY), 'unknown')
  assert.equal(decide({ flags: { under_19_until: '2000-01-01' } }, 19.5, TODAY), 'unknown')
})

test('a verified release returns only the licence verification and the flags', async () => {
  const release = await verify(await buildRelease({ licence: {} }))
  assert.equal(release.vct, 'https://free-id.org/vct/identity/v1')
  assert.equal(release.today, TODAY)
  assert.deepEqual(release.licence, { verification: LICENCE_VERIFICATION, flags: AGE_FLAGS })
})

// Nothing beyond the age flags may arrive, even if FreeID signed it.

for (const [name, value] of [
  ['birthdate', '1998-03-14'],
  ['given_name', 'ALEX'],
  ['family_name', 'MORGAN'],
  ['address', { locality: 'New York', region: 'NY' }],
  ['licence_number', '123456789'],
  ['licence_number_masked', '•••••6789'],
]) {
  test(`a release with the licence ${name} as well is rejected`, async () => {
    await assert.rejects(verify(await buildRelease({ licence: { fields: { ...AGE_FLAGS, [name]: value } } })), {
      message: "Release includes a field that wasn't requested",
    })
  })
}

test('an unknown licence field is rejected', async () => {
  await assert.rejects(verify(await buildRelease({ licence: { fields: { ...AGE_FLAGS, eye_colour: 'BRO' } } })), {
    message: 'Unexpected field',
  })
})

for (const name of ['birthdate', 'given_name', 'document_number_masked']) {
  test(`a release with the passport ${name} is rejected`, async () => {
    await assert.rejects(verify(await buildRelease({ licence: {}, presentPassport: [name] })), {
      message: "Release includes a field that wasn't requested",
    })
  })
}

test('a passport/v1 release with a passport field is rejected', async () => {
  await assert.rejects(verify(await buildRelease({ passportV1: true, presentPassport: ['birthdate'] })), {
    message: "Release includes a field that wasn't requested",
  })
})

test('a forged age flag disclosure is rejected', async () => {
  const jwe = await buildRelease({
    licence: { fields: flagsWith(21, addDays(TODAY, 30)) },
    presented: (issuerJwt, disclosures) => {
      const forged = disclosure('under_21_until', '2000-01-01')
      const parts = disclosures.map((d) => (d.name === 'under_21_until' ? forged.encoded : d.encoded))
      return [issuerJwt, ...parts].join('~') + '~kb.placeholder.sig'
    },
  })
  await assert.rejects(verify(jwe), { message: 'Disclosure not signed by FreeID' })
})

test('an added age flag the licence never had is rejected', async () => {
  const fields = { under_18_until: '2016-03-14' }
  const jwe = await buildRelease({
    licence: { fields },
    presented: (issuerJwt, disclosures) => {
      const added = disclosure('under_21_until', '2000-01-01')
      return [issuerJwt, ...disclosures.map((d) => d.encoded), added.encoded].join('~') + '~kb.placeholder.sig'
    },
  })
  await assert.rejects(verify(jwe), { message: 'Disclosure not signed by FreeID' })
})

test('a forged licence container is rejected', async () => {
  const jwe = await buildRelease({
    licence: {},
    presented: (issuerJwt) => {
      const flag = disclosure('under_21_until', '2000-01-01')
      const forged = disclosure('nys_licence', { verification: LICENCE_VERIFICATION, _sd: [flag.digest] })
      return [issuerJwt, forged.encoded, flag.encoded].join('~') + '~kb.placeholder.sig'
    },
  })
  await assert.rejects(verify(jwe), { message: 'Disclosure not signed by FreeID' })
})

test('an age flag without its container is rejected', async () => {
  const jwe = await buildRelease({
    licence: {},
    presented: (issuerJwt, disclosures) =>
      [issuerJwt, ...disclosures.filter((d) => d.name !== 'nys_licence').map((d) => d.encoded)].join('~') +
      '~kb.placeholder.sig',
  })
  await assert.rejects(verify(jwe), { message: 'Disclosure not signed by FreeID' })
})

test('a dropped age flag disclosure breaks the sd_hash', async () => {
  const jwe = await buildRelease({
    licence: {},
    presented: (issuerJwt, disclosures, kbJwt) =>
      [issuerJwt, ...disclosures.slice(0, -1).map((d) => d.encoded)].join('~') + '~' + kbJwt,
  })
  await assert.rejects(verify(jwe), { message: 'Presentation was altered' })
})

test('a duplicated age flag disclosure is rejected', async () => {
  const jwe = await buildRelease({
    licence: {},
    presented: (issuerJwt, disclosures) => {
      const parts = [...disclosures.map((d) => d.encoded), disclosures[disclosures.length - 1].encoded]
      return [issuerJwt, ...parts].join('~') + '~kb.placeholder.sig'
    },
  })
  await assert.rejects(verify(jwe), { message: 'Duplicate disclosure' })
})

test('an age flag that is not a calendar date is rejected', async () => {
  await assert.rejects(verify(await buildRelease({ licence: { fields: { under_21_until: '2019-02-30' } } })), {
    message: 'Malformed disclosure',
  })
})

test('a signed top-level disclosure other than the licence container is rejected', async () => {
  const jwe = await buildRelease({ extraTopLevel: [disclosure('under_21_until', '2000-01-01')] })
  await assert.rejects(verify(jwe), { message: 'Unexpected field' })
})

for (const [label, verification] of [
  ['claims an issuer signature', { issuer_signature: true }],
  ['names another source', { source: 'mdoc' }],
  ['has no holder match', { holder_match: 'none' }],
]) {
  test(`a licence container that ${label} is rejected`, async () => {
    await assert.rejects(verify(await buildRelease({ licence: { verification } })), {
      message: 'Malformed disclosure',
    })
  })
}

test('an expired licence is rejected', async () => {
  await assert.rejects(verify(await buildRelease({ licence: { verification: { valid_until: addDays(TODAY, -1) } } })), {
    message: 'Licence has expired',
  })
})

test('a licence expiring today is still valid', async () => {
  const release = await verify(await buildRelease({ licence: { verification: { valid_until: TODAY } } }))
  assert.equal(release.licence.verification.valid_until, TODAY)
})

// Binding, issuer and transport.

test('a presentation for another service is rejected', async () => {
  await assert.rejects(verify(await buildRelease({ licence: {}, aud: 'nyc-fibre' })), {
    message: 'Presentation is for another service',
  })
})

test('a presentation with another nonce is rejected', async () => {
  await assert.rejects(verify(await buildRelease({ licence: {}, nonce: 'some-other-nonce' })), {
    message: 'Presentation does not match this sign-in',
  })
})

test('a presentation older than five minutes is rejected', async () => {
  await assert.rejects(verify(await buildRelease({ licence: {}, iat: nowSeconds - 301 })), {
    message: 'Presentation is stale',
  })
})

test('a key-binding JWT signed by another holder key is rejected', async () => {
  const intruder = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true })
  await assert.rejects(verify(await buildRelease({ licence: {}, holderKey: intruder.privateKey })), {
    message: 'Holder key binding failed',
  })
})

test('a presentation without a key-binding JWT is rejected', async () => {
  const jwe = await buildRelease({
    licence: {},
    presented: (issuerJwt, disclosures) => [issuerJwt, ...disclosures.map((d) => d.encoded)].join('~') + '~',
  })
  await assert.rejects(verify(jwe), { message: 'Malformed release' })
})

test('an issuer JWT signed by another key is rejected', async () => {
  await assert.rejects(verify(await buildRelease({ licence: {}, issuerKey: k.other.privateKey })), {
    message: 'Not issued by FreeID',
  })
})

test('an issuer JWT from another issuer is rejected', async () => {
  await assert.rejects(verify(await buildRelease({ licence: {}, iss: 'https://evil.example' })), {
    message: 'Not issued by FreeID',
  })
})

test('an identity/v1 credential without exactly three top-level digests is rejected', async () => {
  await assert.rejects(verify(await buildRelease({ topLevelCount: 2 })), { message: 'Not a FreeID credential' })
})

for (const check of ['passive_authentication', 'csca_chain', 'app_attest']) {
  test(`a credential with ${check} not true is rejected`, async () => {
    await assert.rejects(verify(await buildRelease({ licence: {}, verification: { [check]: false } })), {
      message: 'Passport chip not verified',
    })
  })
}

test('a release encrypted to another key is rejected', async () => {
  await assert.rejects(verify(await buildRelease({ licence: {} }), { encPrivateJwk: k.otherEncPrivate }), {
    message: 'Could not decrypt the release',
  })
})

test('a garbled JWE is rejected', async () => {
  await assert.rejects(verify('not-a-jwe'), { message: 'Could not decrypt the release' })
})
