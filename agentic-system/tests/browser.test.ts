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
  const second = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(page("Identity provider", '<input id="field" style="position:absolute;left:10px;top:10px;width:200px;height:40px">')) })
  await new Promise<void>(resolve => second.listen(0, "127.0.0.1", resolve))
  const providerOrigin = `http://127.0.0.1:${(second.address() as { port: number }).port}`
  // The first provider origin redirects to the second, as api.free-id.org does to www.free-id.org.
  const provider = createServer((_req, res) => { res.statusCode = 302; res.setHeader("location", `${providerOrigin}/verify`); res.end() })
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve))
  const firstOrigin = `http://127.0.0.1:${(provider.address() as { port: number }).port}`
  const target = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(page("Target", `<a href="${firstOrigin}/start" style="position:absolute;left:10px;top:10px;width:300px;height:60px;display:block">Verify with FreeID</a><a href="https://example.com" style="position:absolute;left:10px;top:120px">Third origin</a>`)) })
  await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve))
  const previousTarget = process.env.BROWSER_TARGET_URL
  process.env.BROWSER_TARGET_URL = `http://127.0.0.1:${(target.address() as { port: number }).port}`
  process.env.IDENTITY_PROVIDER_ORIGINS = `${firstOrigin}/ignored/path, not a url, , ${providerOrigin}`
  assert.deepEqual(identityProviderOrigins(), [firstOrigin, providerOrigin])
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
    provider.close(); second.close(); target.close()
  }
})

test("identity providers cannot be reached from target frames or scripts", async () => {
  let providerRequests = 0
  const provider = createServer((_req, res) => { providerRequests++; res.setHeader("content-type", "text/html"); res.end('<html><head><title>Provider</title></head><body><button style="position:absolute;left:0;top:0;width:1280px;height:800px">Provider button</button></body></html>') })
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve))
  const providerOrigin = `http://127.0.0.1:${(provider.address() as { port: number }).port}`
  const target = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(`<html><head><title>Target</title></head><body><iframe src="${providerOrigin}/frame" style="position:absolute;left:0;top:0;width:1280px;height:400px;border:0"></iframe><script>fetch("${providerOrigin}/fetch",{mode:"no-cors"}).then(()=>{document.title="fetched"},()=>{document.title="fetch blocked"})</script></body></html>`) })
  await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve))
  const previousTarget = process.env.BROWSER_TARGET_URL
  process.env.BROWSER_TARGET_URL = `http://127.0.0.1:${(target.address() as { port: number }).port}`
  process.env.IDENTITY_PROVIDER_ORIGINS = providerOrigin
  const m = createMandate(human, { title: "Frame isolation test", maxActions: 20, durationHours: 1, requireApproval: false })
  const run = async (action: Parameters<typeof delegateBrowser>[2]) => { const r = delegateBrowser(human, m.id, action, "frame-worker", "eve"); return executeBrowser(r.id, r.delegation.signature) }
  try {
    const opened = await run({ kind: "navigate", url: process.env.BROWSER_TARGET_URL })
    assert.equal(opened.status, "completed", opened.reason)
    await run({ kind: "inspect" })
    const clicked = await run({ kind: "click", x: 100, y: 100 })
    assert.equal(clicked.status, "completed", clicked.reason)
    assert.equal(clicked.pageTitle, "fetch blocked")
    assert.equal(providerRequests, 0)
  } finally {
    await closeMandateBrowsers(m.id)
    delete process.env.IDENTITY_PROVIDER_ORIGINS
    process.env.BROWSER_TARGET_URL = previousTarget
    provider.close(); target.close()
  }
})

// ---- Vault placeholders: typed for real, never shown back ----
import { chromium } from "playwright"
import { transaction as tx } from "../lib/hac/store"
import { placeholdersFromRelease, storeVault } from "../lib/hac/vault"
import { maskForScreenshot } from "../lib/hac/browser"

process.env.HAC_VAULT_KEY ||= "33".repeat(32)
const vaultValues = placeholdersFromRelease({ fields: { given_name: "ANNE-MARIE", family_name: "SMITH", birthdate: "1990-02-03" }, address: null }, "eyJ.attest~kb")
const formPage = `<html><head><title>Signup</title></head><body>
<input id="name" style="position:absolute;left:10px;top:10px;width:300px;height:40px">
<p id="summary" style="position:absolute;left:10px;top:100px"></p>
<script>document.getElementById("name").addEventListener("input", e => { document.getElementById("summary").textContent = "Thanks, " + e.target.value + " / " + [...e.target.value].reverse().join(""); document.title = "Order for " + e.target.value })</script>
</body></html>`

async function formMandate(port: number) {
  process.env.BROWSER_TARGET_URL = `http://127.0.0.1:${port}`
  const m = createMandate(human, { title: "Vault typing", maxActions: 20, durationHours: 1, requireApproval: false })
  tx(s => storeVault(s, s.mandates.find(x => x.id === m.id)!, vaultValues))
  const open = delegateBrowser(human, m.id, { kind: "navigate", url: process.env.BROWSER_TARGET_URL }, "vault-worker", "eve")
  assert.equal((await executeBrowser(open.id, open.delegation.signature)).status, "completed")
  const click = delegateBrowser(human, m.id, { kind: "click", x: 50, y: 30 }, "vault-worker", "eve")
  assert.equal((await executeBrowser(click.id, click.delegation.signature)).status, "completed")
  return m
}
test("typing a placeholder enters the real value and echoed values are redacted", async () => {
  const site = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(formPage) })
  await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve))
  const m = await formMandate((site.address() as { port: number }).port)
  try {
    const type = delegateBrowser(human, m.id, { kind: "type", text: "{passport.full_name}" }, "vault-worker", "eve")
    const typed = await executeBrowser(type.id, type.delegation.signature)
    assert.equal(typed.status, "completed", typed.reason)
    // Redaction only matches the real value, so the placeholder here proves it was typed.
    assert.match(typed.observation!, /Thanks, \{passport\.full_name\}/)
    assert.equal(/smith|anne/i.test(typed.observation! + typed.pageTitle), false)
    const events = tx(s => s.audit.filter(e => e.runId === type.id))
    assert.ok(events.some(e => e.typedText === "{passport.full_name}"))
    assert.equal(/smith|anne/i.test(JSON.stringify(events)), false)
  } finally { await closeMandateBrowsers(m.id); site.close() }
})
test("unknown placeholders and missing vaults fail without values", async () => {
  const site = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(formPage) })
  await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve))
  const m = await formMandate((site.address() as { port: number }).port)
  try {
    const unknown = delegateBrowser(human, m.id, { kind: "type", text: "{passport.middle_name}" }, "vault-worker", "eve")
    const failed = await executeBrowser(unknown.id, unknown.delegation.signature)
    assert.equal(failed.status, "failed")
    assert.match(failed.reason, /\{passport\.middle_name\}/)
    tx(s => { s.vaults = (s.vaults || []).filter(v => v.mandateId !== m.id) })
    const missing = delegateBrowser(human, m.id, { kind: "type", text: "{passport.full_name}" }, "vault-worker", "eve")
    assert.equal((await executeBrowser(missing.id, missing.delegation.signature)).status, "failed")
  } finally { await closeMandateBrowsers(m.id); site.close() }
})
test("maskForScreenshot hides filled fields and any text showing a value", async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`<input id="name" data-hac-filled="1" value="Anne-Marie Smith"><p>Order for <b>Anne-Marie Smith</b>, born 1990-02-03</p><p>Other text</p>`)
    await maskForScreenshot(page, vaultValues)
    const leaks = await page.evaluate(() => {
      const found: string[] = []
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode())
        if (/smith|1990-02-03/i.test(node.textContent || "") && !node.parentElement?.closest("[data-hac-cover]")) found.push(node.textContent || "")
      return found
    })
    assert.deepEqual(leaks, [])
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("name")!).getPropertyValue("-webkit-text-security")), "disc")
    assert.ok(await page.locator("text=Other text").isVisible())
  } finally { await browser.close() }
})
test("values in the page address are redacted", async () => {
  const site = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(formPage) })
  await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve))
  const m = await formMandate((site.address() as { port: number }).port)
  try {
    const go = delegateBrowser(human, m.id, { kind: "navigate", url: `${process.env.BROWSER_TARGET_URL}/done?name=Anne-Marie%20Smith` }, "vault-worker", "eve")
    const done = await executeBrowser(go.id, go.delegation.signature)
    assert.equal(done.status, "completed", done.reason)
    assert.equal(/smith/i.test(done.pageUrl || ""), false)
  } finally { await closeMandateBrowsers(m.id); site.close() }
})
test("masking never hands vault values to the page's own scripts", async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`<p>Hello Anne-Marie Smith</p><script>
      window.captured = []
      const R = window.RegExp
      window.RegExp = function (...a) { window.captured.push(String(a[0])); return new R(...a) }
      const walker = Document.prototype.createTreeWalker
      Document.prototype.createTreeWalker = function (...a) { window.captured.push("walker"); return walker.apply(this, a) }
    </script>`)
    const unmask = await maskForScreenshot(page, vaultValues)
    assert.deepEqual(await page.evaluate(() => (window as unknown as { captured: string[] }).captured), [])
    assert.equal(await page.locator("[data-hac-cover]").count(), 1)
    await unmask()
    assert.equal(await page.locator("[data-hac-cover]").count(), 0)
  } finally { await browser.close() }
})
test("a page that undoes the masking fails closed instead of exposing values", async () => {
  const sneaky = `<html><head><title>Sneaky</title></head><body><p id="out">Order for Anne-Marie Smith</p>
<script>new MutationObserver(() => { for (const c of document.querySelectorAll("[data-hac-cover]")) c.replaceWith(...c.childNodes) }).observe(document.body, { subtree: true, childList: true })</script></body></html>`
  const site = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(sneaky) })
  await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve))
  process.env.BROWSER_TARGET_URL = `http://127.0.0.1:${(site.address() as { port: number }).port}`
  const m = createMandate(human, { title: "Sneaky page", maxActions: 5, durationHours: 1, requireApproval: false })
  tx(s => storeVault(s, s.mandates.find(x => x.id === m.id)!, vaultValues))
  try {
    const open = delegateBrowser(human, m.id, { kind: "navigate", url: process.env.BROWSER_TARGET_URL }, "sneaky-worker", "eve")
    const run = await executeBrowser(open.id, open.delegation.signature)
    assert.equal(run.status, "failed")
    assert.equal(run.screenshotId, undefined)
    assert.equal(/smith/i.test(JSON.stringify(run)), false)
  } finally { await closeMandateBrowsers(m.id); site.close() }
})
test("a vault that cannot be opened fails the action instead of leaving it claimed", async () => {
  const site = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(formPage) })
  await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve))
  const m = await formMandate((site.address() as { port: number }).port)
  const key = process.env.HAC_VAULT_KEY
  try {
    process.env.HAC_VAULT_KEY = "55".repeat(32)
    const type = delegateBrowser(human, m.id, { kind: "type", text: "{passport.full_name}" }, "vault-worker", "eve")
    const run = await executeBrowser(type.id, type.delegation.signature)
    assert.equal(run.status, "failed")
  } finally { process.env.HAC_VAULT_KEY = key; await closeMandateBrowsers(m.id); site.close() }
})
test("typing {attestation} enters the credential", async () => {
  const site = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(formPage) })
  await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve))
  const m = await formMandate((site.address() as { port: number }).port)
  try {
    const type = delegateBrowser(human, m.id, { kind: "type", text: "{attestation}" }, "vault-worker", "eve")
    const run = await executeBrowser(type.id, type.delegation.signature)
    assert.equal(run.status, "completed", run.reason)
    // The reversed echo is not redacted, so it shows what was really typed.
    assert.ok(run.observation!.includes("bk~tsetta.Jye"), run.observation)
  } finally { await closeMandateBrowsers(m.id); site.close() }
})
