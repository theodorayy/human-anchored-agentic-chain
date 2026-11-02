// The door check's public keys: `sig` verifies our client assertions at FreeID;
// `enc` is the key the guest's phone encrypts the release to.
import { publicJwks } from './_lib.js'

export default function handler(req, res) {
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'public, max-age=300')
  res.end(JSON.stringify(publicJwks()))
}
