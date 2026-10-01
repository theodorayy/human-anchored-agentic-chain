import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

function key() {
  const secret = process.env.HAC_SESSION_SECRET || ""
  if (!/^[a-f0-9]{64}$/i.test(secret)) throw new Error("Configure a 32-byte HAC_SESSION_SECRET.")
  return Buffer.from(secret, "hex")
}

// Purpose and application origin are authenticated alongside the ciphertext.
// These cookies contain identity/login state only, never agent authority.
export function sealCookie(purpose: "session" | "oidc", value: unknown, seconds: number) {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key(), iv)
  cipher.setAAD(Buffer.from(`hac:v1:${purpose}:${process.env.APP_URL}`))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ value, expiresAt: Date.now() + seconds * 1000 })), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url")
}

export function openCookie<T>(purpose: "session" | "oidc", token: string | undefined): T | null {
  if (!token || token.length > 3800 || !/^[A-Za-z0-9_-]+$/.test(token)) return null
  try {
    const data = Buffer.from(token, "base64url")
    if (data.length < 29) return null
    const decipher = createDecipheriv("aes-256-gcm", key(), data.subarray(0, 12))
    decipher.setAAD(Buffer.from(`hac:v1:${purpose}:${process.env.APP_URL}`))
    decipher.setAuthTag(data.subarray(12, 28))
    const result = JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString())
    return typeof result.expiresAt === "number" && result.expiresAt > Date.now() ? result.value as T : null
  } catch { return null }
}
