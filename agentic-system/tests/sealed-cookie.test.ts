import { test } from "node:test"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { sealCookie, openCookie } from "../lib/hac/sealed-cookie"

test("encrypted cookies reject expiry, tampering, different purpose, origin and key", () => {
  process.env.APP_URL = "https://hac.example"
  process.env.HAC_SESSION_SECRET = randomBytes(32).toString("hex")
  const principal = { id: "principal", provider: "oidc", name: "Principal" }
  const token = sealCookie("session", principal, 60)
  assert.deepEqual(openCookie("session", token), principal)
  assert.equal(openCookie("oidc", token), null)
  assert.equal(openCookie("session", sealCookie("session", principal, -1)), null)
  const tampered = Buffer.from(token, "base64url"); tampered[0] ^= 1
  assert.equal(openCookie("session", tampered.toString("base64url")), null)
  process.env.APP_URL = "https://another.example"
  assert.equal(openCookie("session", token), null)
  process.env.APP_URL = "https://hac.example"
  process.env.HAC_SESSION_SECRET = randomBytes(32).toString("hex")
  assert.equal(openCookie("session", token), null)
})
