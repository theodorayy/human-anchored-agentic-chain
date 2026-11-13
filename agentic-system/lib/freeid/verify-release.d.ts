import type { JSONWebKeySet, JWK } from "jose"

export type VerifiedRelease = {
  presentation: string
  vct: string
  fields: Record<string, string>
  verification: Record<string, unknown>
  licence: { verification: Record<string, unknown>; fields: Record<string, unknown> } | null
  address: { value: Record<string, string>; source: string; label: string } | null
  holderKey: JWK
}
export function verifyRelease(input: {
  jwe: string
  encPrivateJwk: JWK
  issuerJwks: JSONWebKeySet | ((...args: never[]) => unknown)
  issuer: string
  clientId: string
  nonce: string
  fullNumberRequested?: boolean
  now?: Date
}): Promise<VerifiedRelease>
