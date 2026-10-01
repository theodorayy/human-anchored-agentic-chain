// Opt-in: exercises the public UI, real model and isolated demo browser.
// Approves one evidence-navigation action; never submits a review decision.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { resolve } from "node:path"
import { chromium } from "playwright"
import { Client } from "eve/client"
import { createSession } from "../lib/hac/auth"
import { revokeMandate } from "../lib/hac/control-plane"
import { transaction } from "../lib/hac/store"

assert.equal(process.env.HAC_LIVE_APPROVAL_TEST, "1", "Set HAC_LIVE_APPROVAL_TEST=1 to run this live model test.")
assert.ok(process.env.AI_GATEWAY_API_KEY, "A model connection is required.")
const principal = { id: `approval-smoke:${randomUUID()}`, name: "Approval smoke test", provider: "oidc" as const }
const cookie = createSession(principal).split(";")[0]
const host = process.env.HAC_TEST_URL || process.env.APP_URL || "http://localhost:3003"
const headers = { cookie, origin: process.env.APP_URL || host }
const browser = await chromium.launch({ headless: true, chromiumSandbox: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const token = cookie.slice(cookie.indexOf("=") + 1)
await context.addCookies([{ name: "hac_session", value: token, url: host, httpOnly: true, sameSite: "Lax" }])
const page = await context.newPage()
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const ownRuns = () => transaction(s => s.runs.filter(r => r.principalId === principal.id))
try {
  await page.goto(`${host}/workspace`)
  await page.getByRole("textbox", { name: "Message Eve" }).fill("Open the first queued customer in the Clearance demo and open their Evidence tab. Inspect the evidence, then stop and summarize it. Do not save or submit a review decision.")
  await page.getByRole("button", { name: "Review permissions", exact: true }).click()
  await page.getByRole("button", { name: "Confirm & start task", exact: true }).click()
  await page.getByRole("button", { name: "Approve & continue", exact: true }).first().waitFor({ state: "visible", timeout: 150_000 })
  const pending = ownRuns().find(r => r.status === "approval")!
  assert.ok(pending?.rootSessionId, "The proposed action must belong to this task.")
  assert.equal(pending.approvedAt, null)
  assert.equal(ownRuns().filter(r => ["click", "type", "press"].includes(r.action.kind) && r.status === "completed").length, 0)
  assert.ok(pending.summary, "The approval card must explain the proposed action.")
  await page.screenshot({ path: "/tmp/hac-task-approval-live.png", fullPage: true })
  console.log("PASS: task → permission confirmation → real model/browser → visible approval card with task-scoped evidence.")
  // Only approve opening the Evidence tab, never a save/submit action.
  assert.match(pending.summary!, /evidence/i)
  assert.equal(pending.action.kind, "click")
  await page.getByRole("button", { name: "Approve & continue", exact: true }).first().click()
  const deadline = Date.now() + 100_000
  let resumed = false
  while (Date.now() < deadline) {
    const runs = ownRuns()
    const approved = runs.find(r => r.id === pending.id)
    if (approved?.status === "completed" && runs.some(r => r.workerId === pending.workerId && r.action.kind === "inspect" && r.status === "completed" && r.createdAt > pending.createdAt)) { resumed = true; break }
    await sleep(1500)
  }
  assert.ok(resumed, "Approve & continue must execute the action and resume the same browser worker with an inspection.")
  console.log("PASS: one click on Approve & continue executes the action once and resumes the same browser worker, without another user message.")
  await page.getByRole("button", { name: "Audit log", exact: true }).first().click()
  await page.getByText("You approved an action", { exact: true }).first().waitFor({ state: "visible" })
  await page.screenshot({ path: "/tmp/hac-task-audit-live.png", fullPage: true })
  console.log("PASS: the matching approval and browser results appear in the task audit log.")
} finally {
  await browser.close()
  const ids = transaction(s => ({ mandates: s.mandates.filter(m => m.principalId === principal.id).map(m => m.id), sessions: s.eveSessions.filter(s => s.principalId === principal.id).map(s => s.id) }))
  for (const id of ids.mandates) {
    revokeMandate(principal, id)
    await fetch(`${host}/api/mandates/${id}/revoke`, { method: "POST", headers, signal: AbortSignal.timeout(15_000) }).catch(() => {})
  }
  const client = new Client({ host, headers })
  for (const id of ids.sessions) await client.sessions.attach(id).cancel({ signal: AbortSignal.timeout(15_000) }).catch(() => {})
  transaction(state => {
    for (const run of state.runs.filter(r => r.principalId === principal.id && r.screenshotId)) rmSync(resolve(process.env.HAC_DATA_DIR || ".hac", "screenshots", `${run.screenshotId}.png`), { force: true })
    state.runs = state.runs.filter(r => r.principalId !== principal.id)
    state.mandates = state.mandates.filter(m => m.principalId !== principal.id)
    state.eveSessions = state.eveSessions.filter(s => s.principalId !== principal.id)
    state.audit = state.audit.filter(a => a.principalId !== principal.id)
    state.sessions = state.sessions.filter(s => s.principal.id !== principal.id)
  })
}
