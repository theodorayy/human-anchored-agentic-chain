import { after, test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMandate, delegateBrowser, claimExecution, reviewRun, revokeMandate } from "../lib/hac/control-plane"
import { evaluate, signGrant } from "../lib/hac/policy"
import { transaction } from "../lib/hac/store"
import { createSession, principalFor, requireSameOrigin } from "../lib/hac/auth"
import { bindEveSession } from "../lib/hac/eve-session"

const directory = mkdtempSync(join(tmpdir(), "hac-policy-"))
process.env.HAC_DATA_DIR = directory
process.env.APP_URL = "http://localhost:3003"
const human = { id: "alice", name: "Alice", provider: "oidc" as const }
const other = { id: "bob", name: "Bob", provider: "oidc" as const }
const mandate = (overrides = {}) => createMandate(human, { title: "Review a fictional queue", maxActions: 3, durationHours: 1, requireApproval: true, ...overrides })
const navigate = { kind: "navigate", url: "https://clearance-review-demo.vercel.app/" }
after(() => rmSync(directory, { recursive: true, force: true }))

test("human scope permits target navigation and reserves one action", () => {
  const m = mandate()
  const r = delegateBrowser(human, m.id, navigate, "worker-1", "eve")
  const decision = claimExecution(r.id, r.delegation.signature)
  assert.equal(decision.execute, true)
  assert.equal(transaction(s => s.mandates.find(x => x.id === m.id)!.usedActions), 1)
})
test("another origin is denied without consuming authority", () => {
  const m = mandate()
  const r = delegateBrowser(human, m.id, { ...navigate, url: "https://example.com" }, "worker-2", "eve")
  assert.equal(claimExecution(r.id, r.delegation.signature).run.status, "denied")
  assert.equal(transaction(s => s.mandates.find(x => x.id === m.id)!.usedActions), 0)
})
test("in ask mode typing and key presses run without approval; clicks wait", () => {
  const m = mandate()
  for (const action of [{ kind: "type", text: "2 West Loop Road" }, { kind: "press", key: "Tab" }] as const) {
    const r = delegateBrowser(human, m.id, action, "worker-ask", "eve")
    assert.equal(claimExecution(r.id, r.delegation.signature).execute, true)
  }
  const click = delegateBrowser(human, m.id, { kind: "click", x: 10, y: 10 }, "worker-ask", "eve")
  assert.equal(claimExecution(click.id, click.delegation.signature).run.status, "approval")
})
test("interaction waits for human approval, then rechecks current policy", () => {
  const m = mandate()
  const r = delegateBrowser(human, m.id, { kind: "click", x: 100, y: 100 }, "worker-3", "eve")
  assert.equal(claimExecution(r.id, r.delegation.signature).run.status, "approval")
  assert.throws(() => reviewRun(other, r.id, true), /not found/)
  reviewRun(human, r.id, true)
  assert.equal(claimExecution(r.id, r.delegation.signature).execute, true)
})
test("revocation invalidates pending actions and future descendants", () => {
  const m = mandate()
  const r = delegateBrowser(human, m.id, { kind: "click", x: 10, y: 10 }, "worker-4", "eve")
  claimExecution(r.id, r.delegation.signature)
  revokeMandate(human, m.id)
  assert.throws(() => reviewRun(human, r.id, true), /no longer/)
  assert.equal(claimExecution(r.id, r.delegation.signature).execute, false)
  const next = delegateBrowser(human, m.id, navigate, "worker-5", "eve")
  assert.equal(claimExecution(next.id, next.delegation.signature).run.status, "denied")
})
test("expired and tampered grants fail closed, even if approved", () => {
  const m = mandate(), r = delegateBrowser(human, m.id, navigate, "worker-6", "eve")
  const key = transaction(s => s.signingKey)
  assert.equal(evaluate(m, r, key, Date.parse(m.expiresAt) + 1).decision, "deny")
  r.delegation.scope.maxActions = 500
  assert.match(evaluate(m, r, key).reason, /signature/)
  r.delegation = signGrant(r.delegation, key)
  assert.match(evaluate(m, r, key).reason, /exceeds/)
})
test("approval cannot broaden a parent's interaction restrictions", () => {
  const m = mandate(), r = delegateBrowser(human, m.id, navigate, "worker-7", "eve")
  const key = transaction(s => s.signingKey)
  r.delegation = signGrant({ ...r.delegation, scope: { ...r.delegation.scope, requireApproval: false } }, key)
  assert.equal(evaluate(m, r, key).decision, "deny")
})
test("idempotent replay cannot double-consume or repeat a browser effect", () => {
  const m = mandate({ maxActions: 1 })
  const r = delegateBrowser(human, m.id, navigate, "worker-8", "eve", "fixed-request")
  assert.equal(delegateBrowser(human, m.id, navigate, "worker-8", "eve", "fixed-request").id, r.id)
  assert.throws(() => delegateBrowser(human, m.id, { kind: "inspect" }, "worker-8", "eve", "fixed-request"), /another action/)
  assert.equal(claimExecution(r.id, r.delegation.signature).execute, true)
  assert.equal(claimExecution(r.id, r.delegation.signature).execute, false)
  const next = delegateBrowser(human, m.id, navigate, "worker-8", "eve")
  assert.equal(claimExecution(next.id, next.delegation.signature).run.status, "denied")
})
test("cross-principal mandate use and forged executor capabilities fail", () => {
  const m = mandate()
  assert.throws(() => delegateBrowser(other, m.id, navigate, "worker-9", "eve"), /not found/)
  const r = delegateBrowser(human, m.id, navigate, "worker-9", "eve")
  assert.throws(() => claimExecution(r.id, "forged"), /Invalid executor/)
})
test("sessions are opaque and state-changing browser requests require same origin", () => {
  const cookie = createSession(human).split(";")[0]
  assert.equal(principalFor(new Request("http://localhost:3003", { headers: { cookie } }))?.id, human.id)
  assert.equal(principalFor(new Request("http://localhost:3003", { headers: { cookie: "hac_session=forged" } })), null)
  assert.throws(() => requireSameOrigin(new Request("http://localhost:3003", { headers: { origin: "https://attacker.example" } })), /same-origin/)
})
test("browser receipts belong to the authenticated task and reject another task's permissions", () => {
  const m = mandate(), otherMandate = mandate()
  bindEveSession("task-a", human.id, m.id, "Review the first customer")
  const r = delegateBrowser(human, m.id, navigate, "task-worker", "eve", "task-action", "task-a", "Open the review queue")
  assert.equal(r.rootSessionId, "task-a")
  assert.equal(r.summary, "Open the review queue")
  assert.throws(() => delegateBrowser(human, otherMandate.id, navigate, "task-worker-2", "eve", "wrong-task-action", "task-a"), /not bound/)
  bindEveSession("task-a", human.id, m.id, "Changed display title")
  assert.equal(transaction(s => s.eveSessions.find(s => s.id === "task-a")?.title), "Review the first customer")
  assert.throws(() => bindEveSession("task-a", other.id, m.id), /cannot change/)
})
test("a multi-site task reaches only the websites the human chose", () => {
  process.env.BROWSER_TARGETS = "Broker portal=https://broker.example,NYC Fibre=https://fibre.example,Other=https://other.example"
  try {
    const m = mandate({ origins: ["https://broker.example", "https://fibre.example"], requireApproval: false })
    assert.deepEqual(m.origins, ["https://broker.example", "https://fibre.example"])
    for (const [url, worker, status] of [["https://broker.example/#/student", "w-ms-1", "executing"], ["https://fibre.example/", "w-ms-2", "executing"], ["https://other.example/", "w-ms-3", "denied"]] as const) {
      const r = delegateBrowser(human, m.id, { kind: "navigate", url }, worker, "eve")
      assert.equal(claimExecution(r.id, r.delegation.signature).run.status, status, url)
    }
    assert.throws(() => mandate({ origins: ["https://evil.example"] }), /not available/)
    const single = mandate({ origins: ["https://fibre.example"] })
    assert.equal(single.origins, undefined)
    assert.equal(single.origin, "https://fibre.example")
  } finally { delete process.env.BROWSER_TARGETS }
})
test("a grant's site list cannot be widened after signing", () => {
  process.env.BROWSER_TARGETS = "Broker portal=https://broker.example,NYC Fibre=https://fibre.example"
  try {
    const m = mandate({ origins: ["https://broker.example"], requireApproval: false })
    transaction(s => { const x = s.mandates.find(y => y.id === m.id)!; x.origins = ["https://broker.example", "https://fibre.example"]; x.grant.scope.origins = x.origins })
    const r = delegateBrowser(human, m.id, { kind: "navigate", url: "https://fibre.example/" }, "w-ms-4", "eve")
    assert.equal(claimExecution(r.id, r.delegation.signature).run.status, "denied")
  } finally { delete process.env.BROWSER_TARGETS }
})
test("request_identity is pending until a release arrives, then lists placeholders only", async () => {
  process.env.HAC_VAULT_KEY ||= "44".repeat(32)
  const { requestIdentity } = await import("../lib/hac/identity")
  const { storeVault, placeholdersFromRelease } = await import("../lib/hac/vault")
  const { requestIdentityForSession } = await import("../agent/tools/request_identity")
  const m = mandate()
  bindEveSession("identity-task", human.id, m.id, "t")
  assert.deepEqual(requestIdentityForSession("identity-task", human.id), { status: "pending" })
  assert.deepEqual(transaction(s => requestIdentity(s, human.id, m.id)), { status: "pending" })
  transaction(s => storeVault(s, s.mandates.find(x => x.id === m.id)!, placeholdersFromRelease({ fields: { given_name: "ANNE", family_name: "SMITH" }, address: null }, "cred")))
  const ready = requestIdentityForSession("identity-task", human.id)
  assert.equal(ready.status, "ready")
  assert.ok("placeholders" in ready && ready.placeholders.includes("{passport.family_name}"))
  assert.equal(/smith|anne|cred/i.test(JSON.stringify(ready).replace(/\{[a-z._]+\}/g, "")), false)
  assert.throws(() => requestIdentityForSession("identity-task", other.id), /binding/)
})
