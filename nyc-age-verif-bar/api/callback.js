// FreeID redirects here once the guest has approved (or declined) the age-flag
// release on their phone. We exchange the code, verify the ID token, collect the
// encrypted release from /userinfo, decrypt and verify it, decide YES / NO /
// CAN'T CONFIRM for the threshold chosen at /api/login, and hand the page only
// that decision in a short-lived sealed cookie. Released dates are never logged,
// stored or sent to the browser; on failure the page only receives a reason code.
import { createRemoteJWKSet, jwtVerify } from 'jose'
import {
  CLIENT_ID,
  FLOW_COOKIE,
  ISSUER,
  REDIRECT_URI,
  RESULT_COOKIE,
  RESULT_COOKIE_PATH,
  THRESHOLDS,
  TIME_ZONE,
  clearCookie,
  discovery,
  encPrivateJwk,
  failureLocation,
  openCookie,
  postForm,
  redirect,
  sealCookie,
} from './_lib.js'
import { decide, verifyRelease } from './_verify.js'

// Long enough for the page to load and read it once; short enough not to linger for the next guest.
const RESULT_MAX_AGE_SECONDS = 120

// verifyRelease's fixed messages, grouped into the page's reason codes.
const RELEASE_REASONS = {
  'Could not decrypt the release': 'decrypt',
  'Not issued by FreeID': 'issuer',
  'Not a FreeID credential': 'issuer',
  'Passport chip not verified': 'chip',
  'Holder key binding failed': 'binding',
  'Presentation is for another service': 'binding',
  'Presentation does not match this sign-in': 'binding',
  'Presentation is stale': 'binding',
  'Presentation was altered': 'binding',
  'Disclosure not signed by FreeID': 'fields',
  'Duplicate disclosure': 'fields',
  'Malformed disclosure': 'fields',
  'Malformed release': 'fields',
  'Unexpected field': 'fields',
  "Release includes a field that wasn't requested": 'fields',
  'Licence has expired': 'licence_expired',
}

class Rejected extends Error {
  constructor(code, detail) {
    super(detail || code)
    this.code = code
  }
}

let issuerKeys
function issuerKeySet(jwksUri) {
  issuerKeys ??= createRemoteJWKSet(new URL(jwksUri))
  return issuerKeys
}

export default async function handler(req, res) {
  const fail = (code) => redirect(res, failureLocation(code), clearCookie(FLOW_COOKIE))
  try {
    const attempt = openCookie(req, FLOW_COOKIE)
    const { code, state, error } = req.query
    // Only this browser's own check may end here, including a decline.
    if (!attempt || attempt.phase !== 'login' || !state || state !== attempt.state) {
      throw new Rejected('expired', 'flow cookie missing or state mismatch')
    }
    if (!THRESHOLDS.includes(attempt.min)) throw new Rejected('threshold', 'no threshold in the flow cookie')
    if (error === 'access_denied') return fail('declined')
    if (error || !code) throw new Rejected('signin', 'authorisation error from FreeID')

    const config = await discovery()
    const token = await postForm(config.token_endpoint, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: attempt.verifier,
    })
    if (!token.ok || !token.json.id_token || !token.json.access_token) {
      throw new Rejected('signin', `token exchange failed (${token.status} ${token.json.error})`)
    }

    const keys = issuerKeySet(config.jwks_uri)
    let idToken
    try {
      ;({ payload: idToken } = await jwtVerify(token.json.id_token, keys, {
        issuer: ISSUER,
        audience: CLIENT_ID,
        algorithms: ['ES256'],
        requiredClaims: ['exp', 'iat'],
      }))
    } catch (failure) {
      throw new Rejected('signin', `ID token: ${failure.code || failure.message}`)
    }
    if (idToken.nonce !== attempt.nonce) throw new Rejected('signin', 'ID token nonce mismatch')
    if (!Array.isArray(idToken.amr) || !idToken.amr.includes('nansen')) {
      throw new Rejected('signin', 'ID token amr lacks nansen')
    }

    const info = await fetch(config.userinfo_endpoint, {
      headers: { authorization: `Bearer ${token.json.access_token}` },
      signal: AbortSignal.timeout(30_000),
    })
    const type = info.headers.get('content-type') || ''
    if (!info.ok || !type.startsWith('application/jwt')) {
      throw new Rejected('unavailable', `userinfo returned ${info.status} ${type}`)
    }

    // FreeID relays the phone's release unread; only our encryption key opens it.
    let release
    try {
      release = await verifyRelease({
        jwe: await info.text(),
        encPrivateJwk: encPrivateJwk(),
        issuerJwks: keys,
        issuer: ISSUER,
        clientId: CLIENT_ID,
        nonce: attempt.nonce,
        timeZone: TIME_ZONE,
      })
    } catch (failure) {
      throw new Rejected(RELEASE_REASONS[failure.message] || 'error', failure.message)
    }

    // The flag dates go no further than this line: only the decision leaves.
    const decision = decide(release.licence, attempt.min, release.today)
    redirect(res, '/?freeid=result', [
      clearCookie(FLOW_COOKIE),
      sealCookie(RESULT_COOKIE, { phase: 'decided', min: attempt.min, decision }, RESULT_MAX_AGE_SECONDS, RESULT_COOKIE_PATH),
    ])
  } catch (failure) {
    if (failure instanceof Rejected) {
      console.error(`FreeID release rejected (${failure.code}):`, failure.message)
      return fail(failure.code)
    }
    console.error('FreeID callback failed:', failure.message)
    fail('error')
  }
}
