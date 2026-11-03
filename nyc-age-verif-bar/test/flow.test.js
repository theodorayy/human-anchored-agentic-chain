// End-to-end door check against a stand-in FreeID served locally:
// /api/login?min=N → /api/callback (token, ID token, /userinfo release) → /api/result.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { SignJWT, jwtVerify, importJWK } from 'jose'
import { AGE_FLAGS, addDays, buildRelease, k } from './fixtures.js'
import { localDate } from '../api/_verify.js'

let server
let issuer
let freeid // per-test behaviour of the stand-in FreeID
let api

before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, issuer)
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
      })
    }
    if (url.pathname === '/jwks') return json(200, { keys: [k.freeidPublic] })
    if (url.pathname === '/token') {
      let body = ''
      for await (const chunk of req) body += chunk
      const form = new URLSearchParams(body)
      freeid.tokenRequest = form
      const sigPublic = { kty: 'EC', crv: 'P-256', x: k.sigPrivate.x, y: k.sigPrivate.y }
      await jwtVerify(form.get('client_assertion'), await importJWK(sigPublic, 'ES256'), {
        issuer: 'nyc-age-verif-bar',
        audience: `${issuer}/token`,
      })
      const idToken = await new SignJWT({ nonce: freeid.nonce, amr: ['nansen'] })
        .setProtectedHeader({ alg: 'ES256', kid: 'freeid-1' })
        .setIssuer(issuer)
        .setAudience('nyc-age-verif-bar')
        .setSubject('pairwise-sub')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(k.freeid.privateKey)
      return json(200, { id_token: idToken, access_token: 'at-1', token_type: 'Bearer' })
    }
    if (url.pathname === '/userinfo') {
      assert.equal(req.headers.authorization, 'Bearer at-1')
      res.writeHead(200, { 'content-type': 'application/jwt' })
      return res.end(freeid.release)
    }
    res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  issuer = `http://127.0.0.1:${server.address().port}`
  process.env.FREEID_ISSUER = issuer
  process.env.COOKIE_SECRET = 'test-cookie-secret'
  process.env.BAR_PRIVATE_JWK = JSON.stringify(k.sigPrivate)
  process.env.BAR_ENC_PRIVATE_JWK = JSON.stringify(k.encPrivate)
  api = {
    login: (await import('../api/login.js')).default,
    callback: (await import('../api/callback.js')).default,
    result: (await import('../api/result.js')).default,
    jwks: (await import('../api/jwks.js')).default,
  }
})

after(() => server.close())

function call(handler, { query = {}, cookies = [] } = {}) {
  const headers = {}
  const req = { query, headers: { cookie: cookies.join('; ') } }
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      setHeader: (name, value) => (headers[name.toLowerCase()] = value),
      end: (body) => resolve({ status: res.statusCode, headers, body }),
    }
    handler(req, res)
  })
}

const setCookies = (response) => [].concat(response.headers['set-cookie'] || [])
const cookiePairs = (response) => setCookies(response).map((c) => c.split(';')[0]).filter((c) => !c.endsWith('='))
const reasonOf = (response) => new URL(response.headers.location, 'https://bar.test').searchParams.get('reason')
const today = () => localDate(new Date(), 'America/New_York')

async function startLogin(min) {
  const login = await call(api.login, { query: { min: String(min) } })
  assert.equal(login.status, 302)
  const authorize = new URL(login.headers.location)
  freeid = { nonce: authorize.searchParams.get('nonce') }
  return { login, authorize, state: authorize.searchParams.get('state') }
}

/** Runs one door check end to end and returns the callback response and /api/result's body. */
async function check(min, tweak = {}, callbackQuery = {}) {
  const { login, state } = await startLogin(min)
  freeid.release = await buildRelease({ iss: issuer, nonce: freeid.nonce, now: new Date(), ...tweak })
  const callback = await call(api.callback, {
    query: { code: 'code-1', state, ...callbackQuery },
    cookies: cookiePairs(login),
  })
  if (callback.headers.location !== '/?freeid=result') return { callback }
  const result = await call(api.result, { cookies: cookiePairs(callback) })
  return { callback, result, body: JSON.parse(result.body) }
}

function decodedCookies(response) {
  return setCookies(response).map((cookie) => {
    const [pair, ...attributes] = cookie.split(';')
    const data = pair.slice(pair.indexOf('=') + 1).split('.')[0]
    return `${attributes.join(';')}\n${data ? Buffer.from(data, 'base64url').toString() : ''}`
  })
}

test('login asks only for the passport and licence age flags, with PKCE and a nonce, and keeps the threshold to itself', async () => {
  for (const min of [18, 21]) {
    const { authorize } = await startLogin(min)
    assert.equal(authorize.searchParams.get('scope'), 'openid passport passport:age_flags licence licence:age_flags')
    assert.equal(authorize.searchParams.get('client_id'), 'nyc-age-verif-bar')
    assert.equal(authorize.searchParams.get('redirect_uri'), 'https://nyc-age-verif-bar.vercel.app/api/callback')
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256')
    assert.ok(authorize.searchParams.get('code_challenge'))
    assert.ok(authorize.searchParams.get('nonce'))
    assert.ok(![...authorize.searchParams.values()].includes(String(min)))
  }
})

for (const min of [undefined, '', '19', '20', '18.0', '21; drop', 'abc']) {
  test(`login refuses threshold ${JSON.stringify(min)} without contacting FreeID`, async () => {
    const login = await call(api.login, { query: min === undefined ? {} : { min } })
    assert.equal(login.headers.location, '/?freeid=error&reason=threshold')
    assert.equal(setCookies(login).length, 0)
  })
}

test('the JWKS publishes the signing and encryption public keys only', async () => {
  const { keys } = JSON.parse((await call(api.jwks)).body)
  assert.deepEqual(
    keys.map(({ kid, use, alg }) => ({ kid, use, alg })),
    [
      { kid: 'nyc-age-verif-bar-1', use: 'sig', alg: 'ES256' },
      { kid: 'nyc-age-verif-bar-enc-1', use: 'enc', alg: 'ECDH-ES' },
    ],
  )
  assert.ok(keys.every((key) => key.d === undefined))
})

test('18+: an adult is YES; the browser gets only the threshold and the decision, once', async () => {
  const { callback, result, body } = await check(18, { passportFlags: AGE_FLAGS, licence: {} })
  assert.deepEqual(body, { min: 18, decision: 'yes' })
  assert.equal(freeid.tokenRequest.get('grant_type'), 'authorization_code')
  assert.ok(freeid.tokenRequest.get('code_verifier'))
  const resultCookie = setCookies(callback).find((c) => c.startsWith('bar_result='))
  assert.match(resultCookie, /Path=\/api\/result; HttpOnly; Secure; SameSite=Lax; Max-Age=120/)
  assert.equal(result.headers['x-content-type-options'], 'nosniff')
  assert.match(setCookies(result)[0], /^bar_result=; Path=\/api\/result; .*Max-Age=0/)

  // No released date reaches the redirect, the cookies or /api/result.
  const leaked = [callback.headers.location, decodedCookies(callback).join('\n'), result.body, JSON.stringify(result.headers)]
  for (const value of Object.values(AGE_FLAGS)) {
    for (const text of leaked) assert.ok(!text.includes(value), 'a released date must not reach the browser')
  }
})

test('the result cookie is cleared after one read', async () => {
  const { callback } = await check(21, { licence: {} })
  const first = await call(api.result, { cookies: cookiePairs(callback) })
  assert.equal(first.status, 200)
  // What the browser holds after the first read: nothing.
  const after = await call(api.result, { cookies: cookiePairs(first) })
  assert.equal(after.status, 404)
})

test('21+ passport only: a guest turning 21 today is YES', async () => {
  const passportFlags = { ...AGE_FLAGS, under_21_until: today() }
  assert.deepEqual((await check(21, { passportFlags })).body, { min: 21, decision: 'yes' })
})

test('21+ passport only: a guest turning 21 tomorrow is NO', async () => {
  const passportFlags = { ...AGE_FLAGS, under_21_until: addDays(today(), 1) }
  assert.deepEqual((await check(21, { passportFlags })).body, { min: 21, decision: 'no' })
})

test('18+ passport only: a guest turning 18 tomorrow is NO', async () => {
  const passportFlags = { under_18_until: addDays(today(), 1), under_19_until: addDays(today(), 366), under_21_until: addDays(today(), 1097) }
  assert.deepEqual((await check(18, { passportFlags })).body, { min: 18, decision: 'no' })
})

test('both sources: the passport flag wins over the licence flag', async () => {
  const passportFlags = { ...AGE_FLAGS, under_21_until: addDays(today(), 1) }
  assert.deepEqual((await check(21, { passportFlags, licence: {} })).body, { min: 21, decision: 'no' })
  const licenceFields = { ...AGE_FLAGS, under_21_until: addDays(today(), 1) }
  assert.deepEqual((await check(21, { passportFlags: AGE_FLAGS, licence: { fields: licenceFields } })).body, {
    min: 21,
    decision: 'yes',
  })
})

test('21+ licence only: a guest turning 21 today is YES', async () => {
  const fields = { ...AGE_FLAGS, under_21_until: today() }
  assert.deepEqual((await check(21, { licence: { fields } })).body, { min: 21, decision: 'yes' })
})

test('21+ licence only: a guest turning 21 tomorrow is NO', async () => {
  const fields = { ...AGE_FLAGS, under_21_until: addDays(today(), 1) }
  assert.deepEqual((await check(21, { licence: { fields } })).body, { min: 21, decision: 'no' })
})

test('18+ licence only: a guest turning 18 tomorrow is NO', async () => {
  const fields = { under_18_until: addDays(today(), 1), under_19_until: addDays(today(), 366), under_21_until: addDays(today(), 1097) }
  assert.deepEqual((await check(18, { licence: { fields } })).body, { min: 18, decision: 'no' })
})

test("neither source shared is CAN'T CONFIRM, never YES", async () => {
  assert.deepEqual((await check(21)).body, { min: 21, decision: 'unknown' })
  assert.deepEqual((await check(18, { passportV1: true })).body, { min: 18, decision: 'unknown' })
})

test("a licence without the needed flag is CAN'T CONFIRM", async () => {
  const fields = { under_18_until: '2010-01-01' }
  assert.deepEqual((await check(21, { licence: { fields } })).body, { min: 21, decision: 'unknown' })
})

test('the threshold comes from the sealed flow cookie; a query parameter on the callback cannot change it', async () => {
  const fields = { ...AGE_FLAGS, under_21_until: addDays(today(), 30) }
  const { body } = await check(21, { licence: { fields } }, { min: '18' })
  assert.deepEqual(body, { min: 21, decision: 'no' })
})

test('a release with a field beyond the age flags is refused with a reason code', async () => {
  const { callback } = await check(21, { licence: { fields: { ...AGE_FLAGS, birthdate: '1998-03-14' } } })
  assert.equal(reasonOf(callback), 'fields')
  assert.ok(!setCookies(callback).some((c) => c.startsWith('bar_result=') && !c.includes('Max-Age=0')))
})

test('a release with a passport field is refused', async () => {
  const { callback } = await check(18, { passportFlags: AGE_FLAGS, presentPassport: ['given_name'] })
  assert.equal(reasonOf(callback), 'fields')
})

test('a release with a licence field beside the passport flags is refused', async () => {
  const { callback } = await check(18, { passportFlags: AGE_FLAGS, licence: { fields: { ...AGE_FLAGS, address: { region: 'NY' } } } })
  assert.equal(reasonOf(callback), 'fields')
})

test('a credential without a matched face is refused', async () => {
  const { callback } = await check(21, { passportFlags: AGE_FLAGS, verification: { face_match: 'not_performed' } })
  assert.equal(reasonOf(callback), 'chip')
})

test('a release bound to another check is refused', async () => {
  const { callback } = await check(21, { licence: {}, nonce: 'stale-nonce' })
  assert.equal(callback.headers.location, '/?freeid=error&reason=binding')
})

test('a release for another relying party is refused', async () => {
  const { callback } = await check(21, { licence: {}, aud: 'nyc-fibre' })
  assert.equal(reasonOf(callback), 'binding')
})

test('an expired licence is refused with its own reason', async () => {
  const { callback } = await check(21, { licence: { verification: { valid_until: addDays(today(), -1) } } })
  assert.equal(reasonOf(callback), 'licence_expired')
})

test('a credential without an attested chip check is refused', async () => {
  const { callback } = await check(21, { licence: {}, verification: { app_attest: false } })
  assert.equal(reasonOf(callback), 'chip')
})

test('a mismatched state is refused before contacting FreeID', async () => {
  const { login } = await startLogin(21)
  const callback = await call(api.callback, { query: { code: 'code-1', state: 'forged' }, cookies: cookiePairs(login) })
  assert.equal(reasonOf(callback), 'expired')
})

test("a decline is only honoured for this browser's own check", async () => {
  const { login, state } = await startLogin(18)
  const declined = await call(api.callback, { query: { error: 'access_denied', state }, cookies: cookiePairs(login) })
  assert.equal(reasonOf(declined), 'declined')
  const noCookie = await call(api.callback, { query: { error: 'access_denied', state } })
  assert.equal(reasonOf(noCookie), 'expired')
})

test('a forged result cookie is ignored', async () => {
  const payload = { phase: 'decided', min: 21, decision: 'yes', exp: Date.now() + 60000 }
  const forged = `bar_result=${Buffer.from(JSON.stringify(payload)).toString('base64url')}.bad`
  assert.equal((await call(api.result, { cookies: [forged] })).status, 404)
})

// The page: no way to type or override anything, fixed copy only.

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const script = /<script>([\s\S]*)<\/script>/.exec(html)[1]

test('the page has fixed copy for every reason code and nothing else', async () => {
  const { REASON_CODES } = await import('../api/_lib.js')
  const block = /const REASONS = \{([\s\S]*?)\n  \}/.exec(script)
  assert.ok(block, 'REASONS map present in the page script')
  const keys = [...block[1].matchAll(/^\s+([a-z_]+):/gm)].map((m) => m[1])
  assert.deepEqual([...keys].sort(), [...REASON_CODES].sort())
})

test('the only controls are 18+, 21+ and Next guest; nothing can be typed', () => {
  assert.ok(!/<(input|select|textarea|form)\b/i.test(html), 'no form fields')
  assert.ok(!/contenteditable/i.test(html), 'nothing editable')
  const buttons = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])
  assert.deepEqual(buttons, ['18+', '21+', 'Next guest', 'Next guest'])
  assert.ok(script.includes("button.dataset.min === '21' ? '21' : '18'"), 'the page only ever sends 18 or 21')
})

test('the page shows no source label and never reads a released value', () => {
  assert.ok(!/LICENCE_SOURCE_LABEL|source-note|not verified by New York State/.test(html))
  assert.ok(!/under_\d+_until|birthdate|given_name|family_name/.test(script))
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(script), 'text only')
})
