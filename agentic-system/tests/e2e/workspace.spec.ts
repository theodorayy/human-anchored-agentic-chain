import { test, expect } from "@playwright/test"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { createSession } from "../../lib/hac/auth"
import { transaction } from "../../lib/hac/store"
import { bindEveSession } from "../../lib/hac/eve-session"
import { createMandate, delegateBrowser, claimExecution, completeExecution } from "../../lib/hac/control-plane"

if (existsSync(".env.local")) process.loadEnvFile(".env.local")
const principal = { id: `e2e:${randomUUID()}`, name: "Browser test principal", provider: "demo" as const }

test.afterAll(() => transaction(state => {
  state.sessions = state.sessions.filter(s => s.principal.id !== principal.id)
  state.mandates = state.mandates.filter(m => m.principalId !== principal.id)
  state.runs = state.runs.filter(r => r.principalId !== principal.id)
  state.audit = state.audit.filter(a => a.principalId !== principal.id)
  state.eveSessions = state.eveSessions.filter(s => s.principalId !== principal.id)
}))

test("login gate hides the workspace, rejects forged cookies, and fits mobile", async ({ page, context }) => {
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "Welcome to your workspace." })).toBeVisible()
  await expect(page.getByRole("button", { name: "Sign in with Free Identity" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Send message" })).toHaveCount(0)
  await context.addCookies([{ name: "hac_session", value: "forged-token", url: "http://localhost:3003" }])
  for (const path of ["/workspace", "/s/some-session"]) {
    await page.goto(path)
    await expect(page).toHaveURL("http://localhost:3003/")
    await expect(page.getByRole("heading", { name: "Welcome to your workspace." })).toBeVisible()
  }
  expect((await context.request.get("/api/state")).status()).toBe(401)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test("task browser and audit log show the same actions and explain failures", async ({ page, context }) => {
  const token = createSession(principal).split(";")[0].split("=")[1]
  await context.addCookies([{ name: "hac_session", value: token, url: "http://localhost:3003", httpOnly: true, sameSite: "Lax" }])
  const response = await context.request.post("/api/mandates", { headers: { origin: "http://localhost:3003" }, data: { title: "Review the first customer", maxActions: 10, durationHours: 1, requireApproval: true } })
  const mandate = await response.json()
  const ownSession = randomUUID()
  bindEveSession(ownSession, principal.id, mandate.id, "Review the first customer")
  const run = delegateBrowser(principal, mandate.id, { kind: "navigate", url: "https://clearance-review-demo.vercel.app" }, "ui-test-worker", "eve", randomUUID(), ownSession, "Open the customer review queue")
  const result = await context.request.post("/api/executor/browser", { headers: { authorization: `Bearer ${run.delegation.signature}` }, data: { runId: run.id } })
  expect((await result.json()).status).toBe("completed")
  // Exercise historical receipts too: old events recorded only the mechanical action.
  transaction(s => { const receipt = s.audit.find(a => a.runId === run.id && a.event === "browser.completed")!; receipt.detail = "Open https://clearance-review-demo.vercel.app"; delete receipt.actionDetail })
  // Session IDs in this test are fixture records; the live model path has a separate smoke test.
  await page.route("**/eve/v1/**", route => route.fulfill({ status: 503, json: { error: "Model disabled in UI fixture" } }))
  await page.goto(`/s/${ownSession}`)
  await expect(page.getByAltText("Latest screenshot from this task’s browser")).toBeVisible()
  await expect(page.getByText("Open the customer review queue", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Open preview" })).toHaveCount(0)
  await page.getByRole("button", { name: "Audit log", exact: true }).first().click()
  await expect(page.getByRole("heading", { name: "What happened, and why." })).toBeVisible()
  await expect(page.getByText("Browser action completed", { exact: true })).toBeVisible()
  const audit = await (await context.request.get("/api/audit/export")).json()
  const completed = page.locator(".audit-list article").filter({ has: page.getByText("Browser action completed", { exact: true }) })
  await expect(completed.locator("p")).toHaveText("Open the customer review queue")
  await completed.getByText("Technical details", { exact: true }).click()
  await expect(completed.locator("small")).toContainText("Open https://clearance-review-demo.vercel.app")
  const receipt = audit.find((e: { event: string }) => e.event === "browser.completed")
  expect(receipt.detail).toBe("Open the customer review queue")
  expect(receipt.actionDetail).toBe("Open https://clearance-review-demo.vercel.app")
  expect(transaction(s => s.audit.find(a => a.runId === run.id && a.event === "browser.completed")?.detail)).toBe("Open https://clearance-review-demo.vercel.app")
  await page.getByRole("button", { name: "Stop browser access", exact: true }).click()
  await expect(page.getByText("Access ended", { exact: true })).toBeVisible()
  await expect(page.getByText("You stopped access", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Architecture", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Every action has a human origin." })).toBeVisible()
  await page.getByRole("button", { name: "Sign out" }).click()
  await expect(page.getByRole("heading", { name: "Welcome to your workspace." })).toBeVisible()
})

for (const allow of [false, true]) test(`task start confirms ${allow ? "autonomous" : "approval-required"} permissions and sends the newly issued authority`, async ({ page, context }) => {
  const token = createSession(principal).split(";")[0].split("=")[1]
  await context.addCookies([{ name: "hac_session", value: token, url: "http://localhost:3003", httpOnly: true, sameSite: "Lax" }])
  await page.route("**/api/state", async route => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...await response.json(), eveAvailable: true } })
  })
  let sentMandate = "", sentTask = ""
  await page.route("**/eve/v1/session", async route => {
    sentMandate = route.request().headers()["x-hac-mandate"] || ""
    sentTask = decodeURIComponent(route.request().headers()["x-hac-task"] || "")
    await route.fulfill({ status: 503, json: { error: "Model disabled in UI fixture" } })
  })
  await page.goto("/workspace")
  await expect(page.getByRole("heading", { name: "What should Eve do?" })).toBeVisible()
  await page.getByRole("button", { name: "Review the first customer", exact: true }).click()
  await page.getByRole("button", { name: "Review permissions", exact: true }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  expect(sentMandate).toBe("")
  if (allow) await page.getByRole("radio", { name: /Let Eve complete the task/ }).check()
  else await expect(page.getByRole("radio", { name: /Ask before each click/ })).toBeChecked()
  await page.getByRole("button", { name: "Confirm & start task", exact: true }).click()
  await expect.poll(() => sentMandate).not.toBe("")
  const issued = transaction(s => s.mandates.find(m => m.id === sentMandate))
  expect(issued?.requireApproval).toBe(!allow)
  expect(issued?.maxActions).toBe(100)
  expect(sentTask).toContain("Review the first queued customer")
  expect(issued?.title).toBe(sentTask.slice(0, 100))
})

test("audit shows exact typed text safely and exports it for historical receipts", async ({ page, context }) => {
  const token = createSession(principal).split(";")[0].split("=")[1]
  await context.addCookies([{ name: "hac_session", value: token, url: "http://localhost:3003", httpOnly: true, sameSite: "Lax" }])
  const mandate = createMandate(principal, { title: "Review notes audit fixture", maxActions: 10, durationHours: 1, requireApproval: false })
  const sessionId = randomUUID()
  bindEveSession(sessionId, principal.id, mandate.id, "Review notes audit fixture")
  const text = 'Review notes:\n  Name matches José’s ID.\nEvidence label: <script>alert("test")</script>\n'
  const run = delegateBrowser(principal, mandate.id, { kind: "type", text }, "typed-text-fixture", "eve", randomUUID(), sessionId, "Enter the evidence review notes")
  // A recorded execution fixture: this test checks audit rendering, not browser input.
  claimExecution(run.id, run.delegation.signature)
  completeExecution(run.id, {})
  expect(transaction(s => s.audit.find(a => a.runId === run.id && a.event === "browser.completed")?.typedText)).toBe(text)
  // Existing receipts should recover the text from the original action too.
  transaction(s => { delete s.audit.find(a => a.runId === run.id && a.event === "browser.completed")!.typedText })
  await page.route("**/eve/v1/**", route => route.fulfill({ status: 503, json: { error: "Model disabled in UI fixture" } }))
  await page.goto(`/s/${sessionId}`)
  await page.getByRole("button", { name: "Audit log", exact: true }).first().click()
  await expect(page.locator(".audit-typed-text pre")).toBeVisible()
  expect(await page.locator(".audit-typed-text pre").textContent()).toBe(text)
  await expect(page.locator(".audit-typed-text script")).toHaveCount(0)
  const events = await (await context.request.get("/api/audit/export")).json()
  expect(events.find((e: { runId?: string; event: string }) => e.runId === run.id && e.event === "browser.completed").typedText).toBe(text)
  expect(events.filter((e: { runId?: string; event: string }) => e.runId === run.id && e.event !== "browser.completed").every((e: { typedText?: string }) => e.typedText === undefined)).toBe(true)
})

test("unauthenticated callers cannot create mandates or access browser execution", async ({ request }) => {
  const result = await request.post("/api/mandates", { headers: { origin: "http://localhost:3003" }, data: {} })
  expect(result.status()).toBe(401)
  const executor = await request.post("/api/executor/browser", { data: { runId: "unknown" } })
  expect(executor.status()).toBe(403)
  const keys = await (await request.get("/.well-known/jwks.json")).json()
  expect(keys.keys[0].kty).toBe("EC")
  expect(keys.keys[0].d).toBeUndefined()
})
