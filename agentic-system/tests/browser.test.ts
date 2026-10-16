import { after, test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMandate, delegateBrowser, reviewRun, revokeMandate } from "../lib/hac/control-plane"
import { executeBrowser, closeMandateBrowsers } from "../lib/hac/browser"
import { identityProviderOrigins } from "../lib/hac/policy"

const directory = mkdtempSync(join(tmpdir(), "hac-browser-"))
process.env.HAC_DATA_DIR = directory
const human = { id: "browser-test", name: "Test", provider: "oidc" as const }
const server = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end('<html><head><title>Browser fixture</title></head><body><button style="position:absolute;left:10px;top:10px;width:200px;height:80px" onclick="this.textContent=\'Approved click\'">Pending click</button><a href="https://example.com" style="position:absolute;left:10px;top:120px">Outside origin</a></body></html>') })
after(() => { server.close(); rmSync(directory, { recursive: true, force: true }) })
test("real Chromium enforces approval, executes once, captures evidence, and blocks other origins", async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  process.env.BROWSER_TARGET_URL = `http://127.0.0.1:${port}`
  const m = createMandate(human, { title: "Browser boundary test", maxActions: 10, durationHours: 1, requireApproval: true })
  try {
    const open = delegateBrowser(human, m.id, { kind: "navigate", url: process.env.BROWSER_TARGET_URL }, "test-worker", "manual")
    const opened = await executeBrowser(open.id, open.delegation.signature)
    assert.equal(opened.status, "completed", opened.reason)
    assert.equal(opened.pageTitle, "Browser fixture")
    assert.ok(opened.screenshotId)
    const click = delegateBrowser(human, m.id, { kind: "click", x: 50, y: 50 }, "test-worker", "eve")
    assert.equal((await executeBrowser(click.id, click.delegation.signature)).status, "approval")
    reviewRun(human, click.id, true)
    const clicked = await executeBrowser(click.id, click.delegation.signature)
    assert.equal(clicked.status, "completed", clicked.reason)
    assert.match(clicked.observation!, /Approved click/)
    assert.equal((await executeBrowser(click.id, click.delegation.signature)).screenshotId, clicked.screenshotId)
    const outside = delegateBrowser(human, m.id, { kind: "navigate", url: "https://example.com" }, "test-worker", "eve")
    assert.equal((await executeBrowser(outside.id, outside.delegation.signature)).status, "denied")
    revokeMandate(human, m.id)
    const inspect = delegateBrowser(human, m.id, { kind: "inspect" }, "test-worker", "eve")
    assert.equal((await executeBrowser(inspect.id, inspect.delegation.signature)).status, "denied")
  } finally { await closeMandateBrowsers(m.id) }
})
test("the browser follows an identity-provider redirect but cannot act on its pages", async () => {
  const page = (title: string, body = "") => `<html><head><title>${title}</title></head><body style="height:3000px">${body}</body></html>`
  const provider = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(page("Identity provider", '<input id="field" style="position:absolute;left:10px;top:10px;width:200px;height:40px">')) })
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve))
  const providerOrigin = `http://127.0.0.1:${(provider.address() as { port: number }).port}`
  const target = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(page("Target", `<a href="${providerOrigin}/verify" style="position:absolute;left:10px;top:10px;width:300px;height:60px;display:block">Verify with FreeID</a><a href="https://example.com" style="position:absolute;left:10px;top:120px">Third origin</a>`)) })
  await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve))
  const previousTarget = process.env.BROWSER_TARGET_URL
  process.env.BROWSER_TARGET_URL = `http://127.0.0.1:${(target.address() as { port: number }).port}`
  process.env.IDENTITY_PROVIDER_ORIGINS = `${providerOrigin}/ignored/path, not a url, ,`
  assert.deepEqual(identityProviderOrigins(), [providerOrigin])
  const m = createMandate(human, { title: "Identity provider test", maxActions: 20, durationHours: 1, requireApproval: false })
  const run = async (action: Parameters<typeof delegateBrowser>[2]) => { const r = delegateBrowser(human, m.id, action, "idp-worker", "eve"); return executeBrowser(r.id, r.delegation.signature) }
  try {
    assert.equal((await run({ kind: "navigate", url: process.env.BROWSER_TARGET_URL })).status, "completed")
    const redirected = await run({ kind: "click", x: 50, y: 30 })
    assert.equal(redirected.status, "completed", redirected.reason)
    assert.equal(new URL(redirected.pageUrl!).origin, providerOrigin)
    assert.equal((await run({ kind: "inspect" })).status, "completed")
    assert.equal((await run({ kind: "scroll", deltaY: 200 })).status, "completed")
    for (const action of [{ kind: "click", x: 50, y: 30 }, { kind: "type", text: "secret" }, { kind: "press", key: "Enter" }] as const) {
      const refused = await run(action)
      assert.equal(refused.status, "failed")
      assert.equal(refused.reason, "Identity provider pages are view-only for the agent")
    }
    assert.equal((await run({ kind: "navigate", url: `${providerOrigin}/verify` })).status, "denied")
    assert.equal((await run({ kind: "close" })).status, "completed")
    // Third origins stay blocked even while the provider is allowed.
    assert.equal((await run({ kind: "navigate", url: process.env.BROWSER_TARGET_URL })).status, "completed")
    const blocked = await run({ kind: "click", x: 50, y: 130 })
    assert.notEqual(blocked.pageTitle, "Example Domain")
    assert.ok(!(blocked.pageUrl ?? "").startsWith("https://example.com"), blocked.pageUrl)
  } finally {
    await closeMandateBrowsers(m.id)
    delete process.env.IDENTITY_PROVIDER_ORIGINS
    process.env.BROWSER_TARGET_URL = previousTarget
    provider.close(); target.close()
  }
})
