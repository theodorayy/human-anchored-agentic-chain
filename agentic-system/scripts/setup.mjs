import { generateKeyPairSync } from "node:crypto"
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs"
import { resolve } from "node:path"

const file = resolve(".env.local")
const current = existsSync(file) ? readFileSync(file, "utf8") : ""
const defaults = {
  APP_URL: "http://localhost:3003",
  HAC_DATA_DIR: resolve(".hac"),
  OIDC_ISSUER: "http://localhost:3006",
  OIDC_CLIENT_ID: "hac-agentic-system",
  BROWSER_TARGET_URL: "https://clearance-review-demo.vercel.app",
  HAC_DEMO: "false",
}
const missing = Object.entries(defaults).filter(([key]) => !new RegExp(`^${key}=`, "m").test(current))
if (!/^OIDC_CLIENT_PRIVATE_JWK=/m.test(current)) {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
  missing.push(["OIDC_CLIENT_PRIVATE_JWK", JSON.stringify(privateKey.export({ format: "jwk" }))])
}
if (missing.length) writeFileSync(file, current + "\n" + missing.map(([k, v]) => `${k}='${v}'`).join("\n") + "\n", { mode: 0o600 })
chmodSync(file, 0o600)
console.log("Local configuration ready. Existing values preserved; private key stays in .env.local.")
console.log("HAC: http://localhost:3003 · FreeID issuer: http://localhost:3006")
console.log("Add AI_GATEWAY_API_KEY to .env.local to enable Eve model calls.")
