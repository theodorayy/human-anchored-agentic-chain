// FreeID redirects here after sign-in. We exchange the code, verify the ID
// token, then ask FreeID (CIBA backchannel) for the holder's details. The
// holder approves that release on their phone; /api/poll collects it.
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { CLIENT_ID, ISSUER, REDIRECT_URI, discovery, openCookie, postForm, redirect, sealCookie } from './_lib.js'

export default async function handler(req, res) {
  const fail = (reason) => redirect(res, `/?freeid=error&reason=${encodeURIComponent(reason)}`)
  try {
    const attempt = openCookie(req)
    const { code, state, error, error_description: description } = req.query
    if (error) return fail(description || error)
    if (!attempt || attempt.phase !== 'login' || !code || state !== attempt.state) {
      return fail('Sign-in expired or did not match. Try again.')
    }

    const config = await discovery()
    const token = await postForm(config.token_endpoint, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: attempt.verifier,
    })
    if (!token.ok || !token.json.id_token) {
      return fail(token.json.error_description || 'FreeID rejected the sign-in.')
    }

    const { payload } = await jwtVerify(token.json.id_token, createRemoteJWKSet(new URL(config.jwks_uri)), {
      issuer: ISSUER,
      audience: CLIENT_ID,
      algorithms: ['ES256', 'RS256'],
    })
    if (payload.nonce !== attempt.nonce) return fail('Sign-in did not match this request.')

    const backchannel = await postForm(config.backchannel_authentication_endpoint, {
      scope: 'openid profile',
      id_token_hint: token.json.id_token,
      binding_message: 'NYC Fibre: verify your identity for a home internet account',
    })
    if (!backchannel.ok || !backchannel.json.auth_req_id) {
      return fail(backchannel.json.error_description || 'FreeID could not reach your phone.')
    }

    redirect(
      res,
      '/?freeid=pending',
      sealCookie(
        {
          phase: 'pending',
          authReqId: backchannel.json.auth_req_id,
          interval: backchannel.json.interval || 5,
          amr: Array.isArray(payload.amr) ? payload.amr : [],
        },
        backchannel.json.expires_in || 300,
      ),
    )
  } catch (error) {
    fail(error.message)
  }
}
