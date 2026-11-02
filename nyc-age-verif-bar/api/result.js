// Tells the page once which threshold was checked and the door's answer
// (yes / no / unknown), then clears it. Never carries a released value.
import { RESULT_COOKIE, RESULT_COOKIE_PATH, THRESHOLDS, clearCookie, openCookie } from './_lib.js'

const DECISIONS = ['yes', 'no', 'unknown']

export default function handler(req, res) {
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-type', 'application/json')
  res.setHeader('x-content-type-options', 'nosniff')
  const result = openCookie(req, RESULT_COOKIE)
  res.setHeader('set-cookie', clearCookie(RESULT_COOKIE, RESULT_COOKIE_PATH))
  if (!result || result.phase !== 'decided' || !THRESHOLDS.includes(result.min) || !DECISIONS.includes(result.decision)) {
    res.statusCode = 404
    res.end(JSON.stringify({ error: 'no_result' }))
    return
  }
  res.statusCode = 200
  res.end(JSON.stringify({ min: result.min, decision: result.decision }))
}
