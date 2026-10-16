// FreeID redirects here once the holder has released their passport details
// from their phone (or declined). We exchange the code, verify the ID token,
// collect the encrypted release from /userinfo, decrypt and verify it, and tell
// the page in a short-lived sealed cookie which fields arrived and which checks
// passed. Released values stay on this server: they are never logged and never
// reach the browser (or an agent driving it); on failure the page only ever
// receives a reason code.
import { createRemoteJWKSet, jwtVerify } from 'jose'
import {
  CLIENT_ID,
  FLOW_COOKIE,
  ISSUER,
  REDIRECT_URI,
  RESULT_COOKIE,
  RESULT_COOKIE_PATH,
  clearCookie,
  discovery,
  encPrivateJwk,
  failureLocation,
  openCookie,
  postForm,
  redirect,
  sealCookie,
} from './_lib.js'
import { KNOWN_FIELDS, verifyRelease } from './_verify.js'

const RESULT_MAX_AGE_SECONDS = 600

// verifyRelease's fixed messages, grouped into the page's reason codes.
const RELEASE_REASONS = {
  'Could not decrypt the release': 'decrypt',
  'Not issued by FreeID': 'issuer',
  'Not a FreeID passport credential': 'issuer',
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
  'Release is missing required details': 'fields',
  "Release includes a field that wasn't requested": 'fields',
  'Passport has expired': 'passport_expired',
}

/**
 * What the browser may learn about a verified release: the names of the fields
 * received and the credential's boolean checks. Never a value.
 */
function releaseSummary({ fields, verification }) {
  return {
    received: KNOWN_FIELDS.filter((name) => Object.hasOwn(fields, name)),
    checks: {
      passive_authentication: verification?.passive_authentication === true,
      csca_chain: verification?.csca_chain === true,
      app_attest: verification?.app_attest === true,
    },
  }
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
    // Only this browser's own sign-in may end here, including a decline.
    if (!attempt || attempt.phase !== 'login' || !state || state !== attempt.state) {
      throw new Rejected('expired', 'flow cookie missing or state mismatch')
    }
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
        fullNumberRequested: attempt.full === true,
      })
    } catch (failure) {
      throw new Rejected(RELEASE_REASONS[failure.message] || 'error', failure.message)
    }

    // This prototype has no account store, so the verified values go no further
    // than here; a real ISP would save release.fields against the new account.
    redirect(res, '/?freeid=verified', [
      clearCookie(FLOW_COOKIE),
      sealCookie(
        RESULT_COOKIE,
        { phase: 'verified', ...releaseSummary(release) },
        RESULT_MAX_AGE_SECONDS,
        RESULT_COOKIE_PATH,
      ),
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
