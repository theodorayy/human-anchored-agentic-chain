// FreeID redirects here once the holder has released their passport details
// (and, optionally, the address from their NYS driver's licence) from their
// phone (or declined). The sign-in started either at the top of step 1
// ("Start with FreeID", flow 'start') or at the identity step (flow
// 'identity'); the flow cookie says which, so the page returns to the right place. We exchange the code, verify the ID token,
// collect the encrypted release from /userinfo, decrypt and verify it, and tell
// the page in a short-lived sealed cookie which fields arrived and which checks
// passed. Released values stay on this server: they are never logged and never
// reach the browser (or an agent driving it); on failure the page only ever
// receives a reason code. The one exception is a masked form of the licence
// address (see _address.js); the real address goes into an encrypted cookie
// only this server can read.
import { createRemoteJWKSet, jwtVerify } from 'jose'
import {
  ADDRESS_COOKIE,
  ADDRESS_COOKIE_PATH,
  CLIENT_ID,
  FLOW_COOKIE,
  ISSUER,
  REDIRECT_URI,
  RESULT_COOKIE,
  RESULT_COOKIE_PATH,
  clearCookie,
  discovery,
  encPrivateJwk,
  encryptCookie,
  failureLocation,
  flowOf,
  openCookie,
  postForm,
  redirect,
  sealCookie,
  successLocation,
} from './_lib.js'
import { maskAddress } from './_address.js'
import { KNOWN_FIELDS, verifyRelease } from './_verify.js'

const RESULT_MAX_AGE_SECONDS = 600
// Long enough to finish the signup after the address step.
const ADDRESS_MAX_AGE_SECONDS = 60 * 60

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
  'Licence has expired': 'fields',
  'Passport has expired': 'passport_expired',
}

/**
 * What the browser may learn about a verified release: the names of the fields
 * received and the credential's boolean checks. Never a value, apart from the
 * masked address. Licence fields use FreeID's namespaced ids
 * (`licence.address`); the page labels them as unsigned barcode data.
 */
function releaseSummary({ fields, verification, address }, addressMasked) {
  return {
    ...(addressMasked ? { address_masked: addressMasked } : {}),
    received: [
      ...KNOWN_FIELDS.filter((name) => Object.hasOwn(fields, name)),
      ...(address ? ['licence.address'] : []),
    ],
    checks: {
      passive_authentication: verification?.passive_authentication === true,
      csca_chain: verification?.csca_chain === true,
      app_attest: verification?.app_attest === true,
      face_match: verification?.face_match === 'matched',
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
  let flow = 'identity'
  const fail = (code) => redirect(res, failureLocation(code, flow), clearCookie(FLOW_COOKIE))
  try {
    const attempt = openCookie(req, FLOW_COOKIE)
    // Only routes the page back to where the sign-in started; the state check below still applies.
    if (attempt) flow = flowOf(attempt.flow)
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

    // This prototype has no account store, so the passport values go no further
    // than here; a real ISP would save release.fields against the new account.
    // The licence address is the order's service address, so it is kept for a
    // later server step in an encrypted cookie, with its source label.
    const addressMasked = release.address ? maskAddress(release.address.value) : null
    const cookies = [clearCookie(FLOW_COOKIE)]
    if (addressMasked) {
      const { value, source, label } = release.address
      cookies.push(
        encryptCookie(ADDRESS_COOKIE, { address: value, source, label }, ADDRESS_MAX_AGE_SECONDS, ADDRESS_COOKIE_PATH),
      )
    } else if (flow === 'start') {
      // No address from this release, so an address kept from an earlier one no longer applies.
      cookies.push(clearCookie(ADDRESS_COOKIE, ADDRESS_COOKIE_PATH))
    }
    cookies.push(
      sealCookie(
        RESULT_COOKIE,
        { phase: 'verified', ...releaseSummary(release, addressMasked) },
        RESULT_MAX_AGE_SECONDS,
        RESULT_COOKIE_PATH,
      ),
    )
    redirect(res, successLocation(flow), cookies)
  } catch (failure) {
    if (failure instanceof Rejected) {
      console.error(`FreeID release rejected (${failure.code}):`, failure.message)
      return fail(failure.code)
    }
    console.error('FreeID callback failed:', failure.message)
    fail('error')
  }
}
