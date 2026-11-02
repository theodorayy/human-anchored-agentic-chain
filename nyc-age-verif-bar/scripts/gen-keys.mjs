// Prints fresh secrets for the door check, one env var per line:
//   BAR_PRIVATE_JWK      P-256 private JWK that signs client assertions (kid nyc-age-verif-bar-1)
//   BAR_ENC_PRIVATE_JWK  P-256 private JWK the guest's phone encrypts releases to (kid nyc-age-verif-bar-enc-1)
//   COOKIE_SECRET        HMAC key for the sealed cookies
// Usage: node scripts/gen-keys.mjs   (then add each to Vercel; never commit them)
import { randomBytes } from 'node:crypto'
import { exportJWK, generateKeyPair } from 'jose'

async function privateJwk(alg) {
  const { privateKey } = await generateKeyPair(alg, { crv: 'P-256', extractable: true })
  const { kty, crv, x, y, d } = await exportJWK(privateKey)
  return JSON.stringify({ kty, crv, x, y, d })
}

console.log(`BAR_PRIVATE_JWK='${await privateJwk('ES256')}'`)
console.log(`BAR_ENC_PRIVATE_JWK='${await privateJwk('ECDH-ES')}'`)
console.log(`COOKIE_SECRET='${randomBytes(32).toString('base64url')}'`)
