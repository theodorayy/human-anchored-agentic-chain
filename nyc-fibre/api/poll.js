// Polls FreeID's CIBA token endpoint until the holder approves on their phone,
// then fetches the released details from /userinfo (relayed by FreeID).
import { discovery, openCookie, postForm } from './_lib.js'

function decodeJws(compact) {
  const [, payload] = String(compact).split('.')
  if (!payload) return null
  return JSON.parse(Buffer.from(payload, 'base64url').toString())
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store')
  const send = (status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)) }
  try {
    const pending = openCookie(req)
    if (!pending || pending.phase !== 'pending') return send(400, { status: 'expired' })

    const config = await discovery()
    const token = await postForm(config.token_endpoint, {
      grant_type: 'urn:openid:params:grant-type:ciba',
      auth_req_id: pending.authReqId,
    })
    if (!token.ok) {
      const code = token.json.error
      if (code === 'authorization_pending' || code === 'slow_down') return send(200, { status: 'pending' })
      if (code === 'access_denied') return send(200, { status: 'denied' })
      return send(200, { status: 'error', reason: token.json.error_description || code || 'FreeID error' })
    }

    const info = await fetch(config.userinfo_endpoint, {
      headers: { authorization: `Bearer ${token.json.access_token}` },
      signal: AbortSignal.timeout(30_000),
    })
    const body = await info.text()
    const type = info.headers.get('content-type') || ''
    // FreeID relays the phone's release unread: a compact JWS signed by the
    // holder's credential key (encryption to our key is still to come).
    const claims = type.includes('jwt') ? decodeJws(body) : JSON.parse(body)
    return send(200, { status: 'approved', claims, amr: pending.amr })
  } catch (error) {
    return send(200, { status: 'error', reason: error.message })
  }
}
