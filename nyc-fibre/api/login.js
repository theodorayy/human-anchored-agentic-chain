// Starts "Verify with FreeID": an OIDC authorization-code + PKCE sign-in at FreeID.
import { createHash, randomBytes } from 'node:crypto'
import { CLIENT_ID, REDIRECT_URI, discovery, redirect, sealCookie } from './_lib.js'

export default async function handler(req, res) {
  try {
    const { authorization_endpoint } = await discovery()
    const state = randomBytes(24).toString('base64url')
    const nonce = randomBytes(24).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    const url = new URL(authorization_endpoint)
    url.search = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: 'code',
      scope: 'openid profile',
      redirect_uri: REDIRECT_URI,
      state,
      nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString()
    redirect(res, url.toString(), sealCookie({ phase: 'login', state, nonce, verifier }, 600))
  } catch (error) {
    redirect(res, `/?freeid=error&reason=${encodeURIComponent(error.message)}`)
  }
}
