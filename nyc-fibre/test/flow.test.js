// End-to-end relying-party flow against a stand-in FreeID served locally:
// /api/login → /api/callback (token, ID token, /userinfo release) → /api/result.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { SignJWT, jwtVerify, importJWK } from 'jose'
import { buildRelease, FIELDS, k } from './fixtures.js'

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
        issuer: 'nyc-fibre',
        audience: `${issuer}/token`,
      })
      const idToken = await new SignJWT({ nonce: freeid.idTokenNonce ?? freeid.nonce, amr: ['nansen'] })
        .setProtectedHeader({ alg: 'ES256', kid: 'freeid-1' })
        .setIssuer(issuer)
        .setAudience('nyc-fibre')
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
  process.env.NYF_PRIVATE_JWK = JSON.stringify(k.sigPrivate)
  process.env.NYF_ENC_PRIVATE_JWK = JSON.stringify(k.encPrivate)
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

async function startLogin(query = {}) {
  const login = await call(api.login, { query })
  assert.equal(login.status, 302)
  const authorize = new URL(login.headers.location)
  freeid = { nonce: authorize.searchParams.get('nonce') }
  return { login, authorize, state: authorize.searchParams.get('state') }
}

test('login asks for the passport fields without the full number by default', async () => {
  const { authorize } = await startLogin()
  assert.equal(
    authorize.searchParams.get('scope'),
    'openid passport passport:name passport:birthdate passport:nationality passport:expiry passport:number_masked',
  )
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(authorize.searchParams.get('nonce'))
})

test('login with ?full=1 also asks for the full passport number', async () => {
  const { authorize } = await startLogin({ full: '1' })
  assert.ok(authorize.searchParams.get('scope').split(' ').includes('passport:number'))
})

test('the JWKS publishes the signing and encryption public keys only', async () => {
  const response = await call(api.jwks)
  const { keys } = JSON.parse(response.body)
  assert.deepEqual(
    keys.map(({ kid, use, alg }) => ({ kid, use, alg })),
    [
      { kid: 'nyc-fibre-1', use: 'sig', alg: 'ES256' },
      { kid: 'nyc-fibre-enc-1', use: 'enc', alg: 'ECDH-ES' },
    ],
  )
  assert.ok(keys.every((key) => key.d === undefined))
})

// Released values stay on NYC Fibre's server: the browser (and so an agent
// driving it) only learns which fields arrived and which checks passed.
const FULL_NUMBER = 'K1234123Z'
const releasedValues = (fields) =>
  Object.values(fields).flatMap((value) => [value, value.replace(/^•+/, '')])

function decodedCookies(response) {
  return setCookies(response).map((cookie) => {
    // Compare against the decoded payload, not the base64url text, so short values can't match by chance.
    const [pair, ...attributes] = cookie.split(';')
    const data = pair.slice(pair.indexOf('=') + 1).split('.')[0]
    return `${attributes.join(';')}\n${data ? Buffer.from(data, 'base64url').toString() : ''}`
  })
}

function assertNoValues(text, values, where) {
  for (const value of values) assert.ok(!text.includes(value), `${where} must not carry a released value`)
}

test('a verified release reaches the page once through /api/result, without any values', async () => {
  const { login, state } = await startLogin()
  freeid.release = await buildRelease({ iss: issuer, nonce: freeid.nonce, now: new Date() })

  const callback = await call(api.callback, { query: { code: 'code-1', state }, cookies: cookiePairs(login) })
  assert.equal(callback.headers.location, '/?freeid=verified')
  assert.equal(freeid.tokenRequest.get('grant_type'), 'authorization_code')
  assert.ok(freeid.tokenRequest.get('code_verifier'))
  const resultCookie = setCookies(callback).find((c) => c.startsWith('nyf_result='))
  assert.match(resultCookie, /Path=\/api\/result; HttpOnly; Secure; SameSite=Lax; Max-Age=600/)

  const first = await call(api.result, { cookies: cookiePairs(callback) })
  assert.equal(first.status, 200)
  assert.equal(first.headers['x-content-type-options'], 'nosniff')
  const body = JSON.parse(first.body)
  assert.deepEqual(body, {
    received: ['given_name', 'family_name', 'birthdate', 'nationality', 'passport_expiry', 'document_number_masked'],
    checks: { passive_authentication: true, csca_chain: true, app_attest: true, face_match: false },
  })
  assert.match(setCookies(first)[0], /^nyf_result=; Path=\/api\/result; .*Max-Age=0/)

  const values = releasedValues(FIELDS)
  assertNoValues(callback.headers.location, values, 'the callback redirect')
  assertNoValues(decodedCookies(callback).join('\n'), values, 'the result cookie')
  assertNoValues(first.body, values, 'the /api/result body')
  assertNoValues(JSON.stringify(first.headers), values, 'the /api/result headers')
})

test('a release with the full number reports it as received, never its value', async () => {
  const { login, state } = await startLogin({ full: '1' })
  const fields = { document_number: FULL_NUMBER }
  freeid.release = await buildRelease({ iss: issuer, nonce: freeid.nonce, now: new Date(), fields })
  const callback = await call(api.callback, { query: { code: 'code-1', state }, cookies: cookiePairs(login) })
  assert.equal(callback.headers.location, '/?freeid=verified')
  const result = await call(api.result, { cookies: cookiePairs(callback) })
  assert.ok(JSON.parse(result.body).received.includes('document_number'))

  const values = releasedValues({ ...FIELDS, ...fields })
  assertNoValues(decodedCookies(callback).join('\n'), values, 'the result cookie')
  assertNoValues(result.body, values, 'the /api/result body')
})

test('the page renders only field names and checks, never released values', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1]
  // Real mode reads /api/result's `received` and `checks`; nothing on the page reads a field's value.
  assert.ok(!/\bfields\s*[.[]|\{\s*fields\b/.test(script), 'the page script must not handle released fields')
  for (const name of ['given_name', 'family_name', 'birthdate', 'nationality', 'passport_expiry', 'document_number']) {
    assert.ok(!new RegExp(`\\.${name}\\b`).test(script), `the page script must not read ${name} as a value`)
  }
  assert.ok(script.includes("Your details were sent securely to NYC Fibre. They aren't shown on this page."))
})

const reasonOf = (response) => new URL(response.headers.location, 'https://nyc-fibre.test').searchParams.get('reason')

test('a release bound to another sign-in is refused with a reason code', async () => {
  const { login, state } = await startLogin()
  freeid.release = await buildRelease({ iss: issuer, nonce: 'stale-nonce', now: new Date() })
  const callback = await call(api.callback, { query: { code: 'code-1', state }, cookies: cookiePairs(login) })
  assert.equal(callback.headers.location, '/?freeid=error&reason=binding')
  assert.ok(!setCookies(callback).some((c) => c.startsWith('nyf_result=') && !c.includes('Max-Age=0')))
})

test('the full number is accepted only when the sign-in asked for it', async () => {
  const full = await startLogin({ full: '1' })
  freeid.release = await buildRelease({ iss: issuer, nonce: freeid.nonce, now: new Date(), fields: { document_number: 'K1234123Z' } })
  const accepted = await call(api.callback, { query: { code: 'code-1', state: full.state }, cookies: cookiePairs(full.login) })
  assert.equal(accepted.headers.location, '/?freeid=verified')

  const plain = await startLogin()
  freeid.release = await buildRelease({ iss: issuer, nonce: freeid.nonce, now: new Date(), fields: { document_number: 'K1234123Z' } })
  const refused = await call(api.callback, { query: { code: 'code-1', state: plain.state }, cookies: cookiePairs(plain.login) })
  assert.equal(reasonOf(refused), 'fields')
})

test('a credential without an attested chip check is refused', async () => {
  const { login, state } = await startLogin()
  freeid.release = await buildRelease({ iss: issuer, nonce: freeid.nonce, now: new Date(), verification: { app_attest: false } })
  const callback = await call(api.callback, { query: { code: 'code-1', state }, cookies: cookiePairs(login) })
  assert.equal(reasonOf(callback), 'chip')
})

test('a mismatched state is refused before contacting FreeID', async () => {
  const { login } = await startLogin()
  const callback = await call(api.callback, { query: { code: 'code-1', state: 'forged' }, cookies: cookiePairs(login) })
  assert.equal(reasonOf(callback), 'expired')
})

test('a decline is only honoured for this browser\'s own sign-in', async () => {
  const { login, state } = await startLogin()
  const declined = await call(api.callback, { query: { error: 'access_denied', state }, cookies: cookiePairs(login) })
  assert.equal(reasonOf(declined), 'declined')
  const forged = await call(api.callback, { query: { error: 'access_denied', state: 'forged' }, cookies: cookiePairs(login) })
  assert.equal(reasonOf(forged), 'expired')
  const noCookie = await call(api.callback, { query: { error: 'access_denied', state } })
  assert.equal(reasonOf(noCookie), 'expired')
})

test('the page has fixed copy for every reason code and nothing else', async () => {
  const { REASON_CODES } = await import('../api/_lib.js')
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const block = /const REASONS = \{([\s\S]*?)\n  \}/.exec(html)
  assert.ok(block, 'REASONS map present in the page script')
  const keys = [...block[1].matchAll(/^\s+([a-z_]+):/gm)].map((m) => m[1])
  assert.deepEqual([...keys].sort(), [...REASON_CODES].sort())
})

test('a tampered result cookie is ignored', async () => {
  const forged = `nyf_result=${Buffer.from(JSON.stringify({ phase: 'verified', received: [], checks: {}, exp: Date.now() + 60000 })).toString('base64url')}.bad`
  const response = await call(api.result, { cookies: [forged] })
  assert.equal(response.status, 404)
})
