// Starts "Verify with FreeID": an OIDC authorization-code + PKCE sign-in at
// FreeID, asking for a passport release. `?full=1` also asks for the full
// passport number.
import { createHash, randomBytes } from 'node:crypto'
import { CLIENT_ID, FLOW_COOKIE, REDIRECT_URI, discovery, failureLocation, redirect, scopesFor, sealCookie } from './_lib.js'

export default async function handler(req, res) {
  try {
    const full = req.query?.full === '1'
    const { authorization_endpoint } = await discovery()
    const state = randomBytes(24).toString('base64url')
    // FreeID binds the phone's key-binding JWT to this nonce.
    const nonce = randomBytes(24).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    const url = new URL(authorization_endpoint)
    url.search = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: 'code',
      scope: scopesFor({ full }),
      redirect_uri: REDIRECT_URI,
      state,
      nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString()
    redirect(res, url.toString(), sealCookie(FLOW_COOKIE, { phase: 'login', state, nonce, verifier, full }, 600))
  } catch (error) {
    console.error('FreeID login failed:', error.message)
    redirect(res, failureLocation('unavailable'))
  }
}
