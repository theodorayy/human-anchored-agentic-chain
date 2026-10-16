// Public key FreeID uses to verify NYC Fibre's client assertions.
import { publicJwk } from './_lib.js'

export default function handler(req, res) {
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'public, max-age=300')
  res.end(JSON.stringify({ keys: [publicJwk()] }))
}
