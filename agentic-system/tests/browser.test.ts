import { after, test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMandate, delegateBrowser, reviewRun, revokeMandate } from "../lib/hac/control-plane"
import { executeBrowser, closeMandateBrowsers } from "../lib/hac/browser"

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
