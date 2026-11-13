export const runtime = "nodejs"
export async function GET() {
  const keys = []
  // Explicitly project public fields: never expose the private scalar or metadata.
  if (process.env.OIDC_CLIENT_PRIVATE_JWK) {
    const key = JSON.parse(process.env.OIDC_CLIENT_PRIVATE_JWK)
    keys.push({ kty: key.kty, crv: key.crv, x: key.x, y: key.y, kid: "hac-rp", use: "sig", alg: "ES256" })
  }
  // FreeID encrypts passport releases to this key.
  if (process.env.OIDC_ENC_PRIVATE_JWK) {
    const key = JSON.parse(process.env.OIDC_ENC_PRIVATE_JWK)
    keys.push({ kty: key.kty, crv: key.crv, x: key.x, y: key.y, kid: "hac-rp-enc", use: "enc", alg: "ECDH-ES" })
  }
  return Response.json({ keys })
}
