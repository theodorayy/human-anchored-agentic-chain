// Starts a door check: an OIDC authorization-code + PKCE sign-in at FreeID
// asking only for the licence age flags. `?min=18` or `?min=21` picks the
// threshold; it travels in the sealed flow cookie, never back through FreeID.
import { createHash, randomBytes } from 'node:crypto'
import {
  CLIENT_ID,
  FLOW_COOKIE,
  REDIRECT_URI,
  SCOPES,
  THRESHOLDS,
  discovery,
  failureLocation,
  redirect,
  sealCookie,
} from './_lib.js'

export default async function handler(req, res) {
  // Exactly "18" or "21": nothing else, however close, starts a check.
  const min = THRESHOLDS.find((value) => String(value) === req.query?.min)
  if (!min) return redirect(res, failureLocation('threshold'))
  try {
    const { authorization_endpoint } = await discovery()
    const state = randomBytes(24).toString('base64url')
    // FreeID binds the phone's key-binding JWT to this nonce.
    const nonce = randomBytes(24).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    const url = new URL(authorization_endpoint)
    url.search = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: 'code',
      scope: SCOPES,
      redirect_uri: REDIRECT_URI,
      state,
      nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString()
    redirect(res, url.toString(), sealCookie(FLOW_COOKIE, { phase: 'login', state, nonce, verifier, min }, 600))
  } catch (error) {
    console.error('FreeID login failed:', error.message)
    redirect(res, failureLocation('unavailable'))
  }
}
