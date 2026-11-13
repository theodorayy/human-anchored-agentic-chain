import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import type { Mandate, State } from "./types"

// Per-task store for FreeID-released values. Values are encrypted at rest and leave this
// module only to be typed into a page; everything the model, logs or audit see carries
// placeholders such as {passport.family_name} instead.

type Release = { fields: Record<string, string>; address: { value: Record<string, string> } | null }

function key() {
  const hex = process.env.HAC_VAULT_KEY || ""
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("HAC_VAULT_KEY is not configured")
  return Buffer.from(hex, "hex")
}
function seal(plain: string) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(), iv)
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64")
}
function open(sealed: string) {
  const raw = Buffer.from(sealed, "base64")
  const decipher = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(raw.length - 16))
  return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8")
}

const titleCase = (name: string) => name.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, sep: string, letter: string) => sep + letter.toUpperCase())

export function placeholdersFromRelease(release: Release, credential: string): Record<string, string> {
  const out: Record<string, string> = {}
  const f = release.fields
  if (f.given_name) out["passport.given_name"] = titleCase(f.given_name)
  if (f.family_name) out["passport.family_name"] = titleCase(f.family_name)
  const full = [out["passport.given_name"], out["passport.family_name"]].filter(Boolean).join(" ")
  if (full) out["passport.full_name"] = full
  if (f.birthdate) {
    out["passport.birthdate"] = f.birthdate
    const [y, m, d] = f.birthdate.split("-")
    if (y && m && d) out["passport.birthdate.mdy"] = `${m}/${d}/${y}`
  }
  if (f.nationality) out["passport.nationality"] = f.nationality
  if (f.passport_expiry) out["passport.passport_expiry"] = f.passport_expiry
  if (f.document_number_masked) out["passport.document_number_masked"] = f.document_number_masked
  const a = release.address?.value
  if (a) {
    for (const part of ["street_address", "locality", "region", "postal_code"] as const) if (a[part]) out[`licence.${part}`] = a[part]
    const tail = [a.region, a.postal_code].filter(Boolean).join(" ")
    const line = [a.street_address, a.locality, tail].filter(Boolean).join(", ")
    if (line) out["licence.address"] = line
  }
  out.attestation = credential
  return out
}

export function dropVault(state: State, mandateId: string) {
  state.vaults = (state.vaults || []).filter(v => v.mandateId !== mandateId)
}
export function storeVault(state: State, mandate: Mandate, values: Record<string, string>) {
  dropVault(state, mandate.id)
  state.vaults!.push({ mandateId: mandate.id, principalId: mandate.principalId,
    values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, seal(v)])),
    createdAt: new Date().toISOString(), expiresAt: mandate.expiresAt })
}
function live(state: State, mandateId: string, now: number) {
  const vault = (state.vaults || []).find(v => v.mandateId === mandateId)
  if (!vault) return null
  const mandate = state.mandates.find(m => m.id === mandateId)
  if (!mandate || mandate.revokedAt || Date.parse(vault.expiresAt) <= now) { dropVault(state, mandateId); return null }
  return vault
}
export function vaultKeys(state: State, mandateId: string, now = Date.now()): string[] {
  return Object.keys(live(state, mandateId, now)?.values || {})
}
export function openVault(state: State, mandateId: string, now = Date.now()): Record<string, string> | null {
  const vault = live(state, mandateId, now)
  return vault ? Object.fromEntries(Object.entries(vault.values).map(([k, v]) => [k, open(v)])) : null
}

const TOKEN = /\{([a-z]+(?:\.[a-z_]+)+)\}/g
export function resolvePlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(TOKEN, (_, name: string) => {
    if (!Object.hasOwn(values, name)) throw new Error(`Unknown placeholder {${name}}`)
    return values[name]
  })
}
export const hasPlaceholder = (text: string) => new RegExp(TOKEN.source).test(text)

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
// One pass over the text, longest values first, so a replacement never lands inside
// another replacement's placeholder.
export function redact(text: string, values: Record<string, string>): string {
  const entries = Object.entries(values).filter(([, v]) => v.trim().length >= 3).sort((a, b) => b[1].length - a[1].length)
  if (!entries.length || !text) return text
  const patterns = entries.map(([, v]) => escape(v.trim()).replace(/\s+/g, "\\s+"))
  const pattern = new RegExp(patterns.map(p => `(${p})`).join("|"), "giu")
  return text.replace(pattern, (...match) => {
    const index = match.slice(1, entries.length + 1).findIndex(group => group !== undefined)
    return `{${entries[index][0]}}`
  })
}
