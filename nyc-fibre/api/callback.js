// FreeID redirects here once the holder has released their passport details
// from their phone (or declined). We exchange the code, verify the ID token,
// collect the encrypted release from /userinfo, decrypt and verify it, and hand
// the verified fields to the page in a short-lived sealed cookie.
// Released values are never logged.
import { createRemoteJWKSet, jwtVerify } from 'jose'
import {
  CLIENT_ID,
  FLOW_COOKIE,
  ISSUER,
  REDIRECT_URI,
  RESULT_COOKIE,
  clearCookie,
  discovery,
  encPrivateJwk,
  openCookie,
  postForm,
  redirect,
  sealCookie,
} from './_lib.js'
import { verifyRelease } from './verify.js'

const RESULT_MAX_AGE_SECONDS = 600

class Rejected extends Error {}

let issuerKeys
function issuerKeySet(jwksUri) {
  issuerKeys ??= createRemoteJWKSet(new URL(jwksUri))
  return issuerKeys
}

export default async function handler(req, res) {
  const fail = (reason) =>
    redirect(res, `/?freeid=error&reason=${encodeURIComponent(reason)}`, clearCookie(FLOW_COOKIE))
  try {
    const attempt = openCookie(req, FLOW_COOKIE)
    const { code, state, error } = req.query
    if (error === 'access_denied') return fail('You chose not to share your details.')
    if (error) throw new Rejected('FreeID could not complete the sign-in.')
    if (!attempt || attempt.phase !== 'login' || !code || state !== attempt.state) {
      throw new Rejected('Sign-in expired or did not match.')
    }

    const config = await discovery()
    const token = await postForm(config.token_endpoint, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: attempt.verifier,
    })
    if (!token.ok || !token.json.id_token || !token.json.access_token) {
      console.error('FreeID token exchange failed:', token.status, token.json.error)
      throw new Rejected('FreeID rejected the sign-in.')
    }

    const keys = issuerKeySet(config.jwks_uri)
    let idToken
    try {
      ;({ payload: idToken } = await jwtVerify(token.json.id_token, keys, {
        issuer: ISSUER,
        audience: CLIENT_ID,
        algorithms: ['ES256'],
      }))
    } catch {
      throw new Rejected('FreeID sign-in could not be verified.')
    }
    if (idToken.nonce !== attempt.nonce) throw new Rejected('Sign-in did not match this request.')
    if (!Array.isArray(idToken.amr) || !idToken.amr.includes('nansen')) {
      throw new Rejected('This sign-in did not use a FreeID passport credential.')
    }

    const info = await fetch(config.userinfo_endpoint, {
      headers: { authorization: `Bearer ${token.json.access_token}` },
      signal: AbortSignal.timeout(30_000),
    })
    const type = info.headers.get('content-type') || ''
    if (!info.ok || !type.startsWith('application/jwt')) {
      console.error('FreeID userinfo did not return a release:', info.status, type)
      throw new Rejected('FreeID did not return your passport details.')
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
      })
    } catch (failure) {
      throw new Rejected(failure.message)
    }

    redirect(res, '/?freeid=verified', [
      clearCookie(FLOW_COOKIE),
      sealCookie(
        RESULT_COOKIE,
        { phase: 'verified', fields: release.fields, verification: release.verification },
        RESULT_MAX_AGE_SECONDS,
      ),
    ])
  } catch (failure) {
    if (failure instanceof Rejected) {
      console.error('FreeID release rejected:', failure.message)
      const reason = /[.!?]$/.test(failure.message) ? failure.message : `${failure.message}.`
      return fail(`${reason} Try again.`)
    }
    console.error('FreeID callback failed:', failure.message)
    fail('Something went wrong verifying with FreeID. Try again.')
  }
}
