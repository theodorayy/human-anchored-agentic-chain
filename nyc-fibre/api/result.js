// Hands the verified release to the page exactly once, then clears it.
import { RESULT_COOKIE, clearCookie, openCookie } from './_lib.js'

export default function handler(req, res) {
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-type', 'application/json')
  const result = openCookie(req, RESULT_COOKIE)
  res.setHeader('set-cookie', clearCookie(RESULT_COOKIE))
  if (!result || result.phase !== 'verified') {
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'no_result' }))
    return
  }
  res.statusCode = 200
  res.end(JSON.stringify({ fields: result.fields, verification: result.verification }))
}
