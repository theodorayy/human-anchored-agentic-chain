export const runtime = "nodejs"
export async function GET() {
  if (!process.env.OIDC_CLIENT_PRIVATE_JWK) return Response.json({ keys: [] })
  const key = JSON.parse(process.env.OIDC_CLIENT_PRIVATE_JWK)
  // Explicitly project public fields: never expose the private scalar or metadata.
  return Response.json({ keys: [{ kty: key.kty, crv: key.crv, x: key.x, y: key.y,
    kid: "hac-rp", use: "sig", alg: "ES256" }] })
}
