import { after, test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMandate, deleteTask, revokeMandate } from "../lib/hac/control-plane"
import { transaction } from "../lib/hac/store"
import { bindEveSession } from "../lib/hac/eve-session"
import { dropVault, openVault, placeholdersFromRelease, redact, resolvePlaceholders, storeVault, vaultKeys } from "../lib/hac/vault"

const directory = mkdtempSync(join(tmpdir(), "hac-vault-"))
process.env.HAC_DATA_DIR = directory
process.env.HAC_VAULT_KEY = "11".repeat(32)
after(() => rmSync(directory, { recursive: true, force: true }))
const human = { id: "vault-human", name: "V", provider: "oidc" as const }
const mandate = () => createMandate(human, { title: "Vault test", maxActions: 3, durationHours: 1, requireApproval: true })
const release = {
  fields: { given_name: "ANNE-MARIE", family_name: "SMITH", birthdate: "1990-02-03", nationality: "SGP", passport_expiry: "2031-01-01", document_number_masked: "*****123" },
  address: { value: { street_address: "2 West Loop Rd Apt 14C", locality: "New York", region: "NY", postal_code: "10044" } },
}
const values = placeholdersFromRelease(release, "eyJ.x~d~kb")

test("placeholders cover passport, licence and attestation", () => {
  assert.equal(values["passport.given_name"], "Anne-Marie")
  assert.equal(values["passport.family_name"], "Smith")
  assert.equal(values["passport.full_name"], "Anne-Marie Smith")
  assert.equal(values["passport.birthdate"], "1990-02-03")
  assert.equal(values["passport.birthdate.mdy"], "02/03/1990")
  assert.equal(values["licence.address"], "2 West Loop Rd Apt 14C, New York, NY 10044")
  assert.equal(values["attestation"], "eyJ.x~d~kb")
})
test("no licence means no licence keys", () => {
  const v = placeholdersFromRelease({ ...release, address: null }, "c")
  assert.equal(Object.keys(v).some(k => k.startsWith("licence.")), false)
})
test("stored values are ciphertext", () => {
  const m = mandate()
  transaction(s => storeVault(s, s.mandates.find(x => x.id === m.id)!, values))
  const raw = transaction(s => JSON.stringify(s.vaults))
  for (const plain of ["SMITH", "Smith", "1990-02-03", "West Loop"]) assert.equal(raw.includes(plain), false, plain)
  assert.deepEqual(transaction(s => openVault(s, m.id)), values)
})
test("resolves several placeholders in one string", () => {
  assert.equal(resolvePlaceholders("{passport.given_name} {passport.family_name}", values), "Anne-Marie Smith")
  assert.equal(resolvePlaceholders("plain text", {}), "plain text")
})
test("unknown placeholders are rejected", () => {
  assert.throws(() => resolvePlaceholders("{passport.middle_name}", values), (error: Error) =>
    /Unknown placeholder \{passport\.middle_name\}/.test(error.message) && !error.message.includes("Smith"))
})
test("redacts case-insensitive and whitespace variants", () => {
  const out = redact("Name: SMITH, ANNE-MARIE\n2 West  Loop Rd Apt 14C", values)
  for (const leaked of ["SMITH", "Smith", "West"]) assert.equal(out.includes(leaked), false, leaked)
  assert.ok(out.includes("{passport.family_name}"))
})
test("vault is deleted with the task and on revocation", () => {
  const revoked = mandate()
  transaction(s => storeVault(s, s.mandates.find(x => x.id === revoked.id)!, values))
  revokeMandate(human, revoked.id)
  assert.equal(transaction(s => openVault(s, revoked.id)), null)
  assert.deepEqual(transaction(s => vaultKeys(s, revoked.id)), [])

  const deleted = mandate()
  bindEveSession("vault-task", human.id, deleted.id, "t")
  transaction(s => storeVault(s, s.mandates.find(x => x.id === deleted.id)!, values))
  deleteTask(human, "vault-task")
  assert.deepEqual(transaction(s => vaultKeys(s, deleted.id)), [])

  const expired = mandate()
  transaction(s => storeVault(s, s.mandates.find(x => x.id === expired.id)!, values))
  assert.equal(transaction(s => openVault(s, expired.id, Date.now() + 2 * 3_600_000)), null)
  assert.deepEqual(transaction(s => vaultKeys(s, expired.id)), [])

  const dropped = mandate()
  transaction(s => { storeVault(s, s.mandates.find(x => x.id === dropped.id)!, values); dropVault(s, dropped.id) })
  assert.equal(transaction(s => openVault(s, dropped.id)), null)
})
test("short values are redacted as whole words only", () => {
  const short = { "passport.family_name": "Ng", "passport.nationality": "USA" }
  const out = redact("Mr NG lives in the USA; usage of Ngong is fine", short)
  assert.equal(out, "Mr {passport.family_name} lives in the {passport.nationality}; usage of Ngong is fine")
})
test("the attestation placeholder resolves", () => {
  assert.equal(resolvePlaceholders("{attestation}", values), "eyJ.x~d~kb")
  assert.equal(resolvePlaceholders("{other}", values), "{other}")
})
