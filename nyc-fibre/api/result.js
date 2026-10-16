// Tells the page once which fields NYC Fibre received and which checks passed,
// then clears it. Never carries a released value.
import { RESULT_COOKIE, RESULT_COOKIE_PATH, clearCookie, openCookie } from './_lib.js'

export default function handler(req, res) {
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-type', 'application/json')
  res.setHeader('x-content-type-options', 'nosniff')
  const result = openCookie(req, RESULT_COOKIE)
  res.setHeader('set-cookie', clearCookie(RESULT_COOKIE, RESULT_COOKIE_PATH))
  if (!result || result.phase !== 'verified' || !Array.isArray(result.received)) {
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'no_result' }))
    return
  }
  res.statusCode = 200
  res.end(JSON.stringify({ received: result.received, checks: result.checks }))
}
