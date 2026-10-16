import { chromium, type Browser, type BrowserContext, type Page } from "playwright"
import { mkdir, writeFile, readFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { randomUUID } from "node:crypto"
import { claimExecution, checkCurrentAuthority, completeExecution, HttpError } from "./control-plane"
import { identityProviderOrigins } from "./policy"
import type { Run } from "./types"

type Worker = { browser: Browser; context: BrowserContext; page: Page; mandateId: string; principalId: string; timer: NodeJS.Timeout; busy: boolean; currentRun: Run }
const shared = globalThis as typeof globalThis & { hacBrowsers?: Map<string, Worker>; hacBrowserLocks?: Set<string> }
const workers = shared.hacBrowsers ||= new Map<string, Worker>()
const locks = shared.hacBrowserLocks ||= new Set<string>()
export const artifactPath = (id: string) => join(resolve(/* turbopackIgnore: true */ process.env.HAC_DATA_DIR || ".hac"), "screenshots", `${id}.png`)
async function closeWorker(id: string) {
  const worker = workers.get(id)
  if (worker) { clearTimeout(worker.timer); workers.delete(id); await worker.browser.close() }
}
export async function closeMandateBrowsers(mandateId: string) {
  await Promise.all([...workers].filter(([, w]) => w.mandateId === mandateId).map(([id]) => closeWorker(id)))
}
async function getWorker(run: Run) {
  let worker = workers.get(run.workerId)
  if (worker) {
    if (worker.principalId !== run.principalId || worker.mandateId !== run.mandateId) throw new HttpError(403, "Browser context ownership mismatch.")
    return worker
  }
  if (run.action.kind !== "navigate") throw new Error("The browser context has ended. Navigate to the authorized site to start a fresh context.")
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true })
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block", acceptDownloads: false })
    const page = await context.newPage()
    worker = { browser, context, page, principalId: run.principalId, mandateId: run.mandateId,
      timer: setTimeout(() => void closeWorker(run.workerId), 600_000), busy: false, currentRun: run }
    worker.timer.unref()
    const active = worker
    // Every request, redirect, subresource and popup stays inside the grant's origin,
    // plus the configured identity providers, whose pages the agent may only view.
    // No user's browser profile, host credentials, shell or arbitrary JS is exposed.
    await context.route("**/*", async route => {
      try {
        checkCurrentAuthority(active.currentRun)
        const origin = new URL(route.request().url()).origin
        if (origin !== active.currentRun.delegation.scope.origin && !identityProviderOrigins().includes(origin)) return await route.abort("blockedbyclient")
        await route.continue()
      } catch { await route.abort("blockedbyclient") }
    })
    await context.routeWebSocket("**/*", socket => socket.close())
    context.on("page", popup => { if (popup !== page) void popup.close() })
    page.on("dialog", dialog => void dialog.dismiss())
    page.setDefaultTimeout(12_000)
    workers.set(run.workerId, worker)
    return worker
  } catch (error) { await browser.close(); throw error }
}
export async function executeBrowser(runId: string, capability: string) {
  const claim = claimExecution(runId, capability)
  if (!claim.execute) return withScreenshot(claim.run)
  const run = claim.run
  let worker: Worker | undefined
  if (locks.has(run.workerId)) return completeExecution(run.id, {}, "This browser is handling another action. Wait before continuing.")
  locks.add(run.workerId)
  try {
    checkCurrentAuthority(run)
    if (run.action.kind === "close") {
      await closeWorker(run.workerId)
      return completeExecution(run.id, { observation: "Browser context closed and ephemeral state discarded." })
    }
    worker = await getWorker(run)
    if (worker.busy) throw new Error("This browser is handling another action. Wait for it to finish before continuing.")
    worker.busy = true
    worker.currentRun = run
    clearTimeout(worker.timer)
    worker.timer = setTimeout(() => void closeWorker(run.workerId), 600_000)
    worker.timer.unref()
    checkCurrentAuthority(run)
    const { page } = worker
    const action = run.action
    if (action.kind === "navigate") await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 25_000 })
    else {
      const pageOrigin = new URL(page.url()).origin
      if (pageOrigin !== run.delegation.scope.origin) {
        if (!identityProviderOrigins().includes(pageOrigin)) throw new Error("Browser is outside its delegated origin.")
        if (["click", "type", "press"].includes(action.kind)) throw new Error("Identity provider pages are view-only for the agent")
      }
      if (action.kind === "click") await page.mouse.click(action.x, action.y)
      if (action.kind === "type") await page.keyboard.insertText(action.text)
      if (action.kind === "press") await page.keyboard.press(action.key)
      if (action.kind === "scroll") await page.mouse.wheel(0, action.deltaY)
    }
    // Two animation frames allow synchronous click handlers and layout to settle.
    // A click can start a navigation (such as a redirect to an identity provider), which destroys
    // the execution context; wait for the new document and settle again.
    for (let attempt = 0; ; attempt++) {
      try {
        await page.waitForLoadState("domcontentloaded")
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        break
      } catch (error) {
        if (attempt >= 3 || !(error instanceof Error) || !/context was destroyed|navigation/i.test(error.message)) throw error
      }
    }
    checkCurrentAuthority(run)
    const screenshotId = randomUUID()
    const screenshot = await page.screenshot({ type: "png" })
    await mkdir(resolve(/* turbopackIgnore: true */ process.env.HAC_DATA_DIR || ".hac", "screenshots"), { recursive: true, mode: 0o700 })
    await writeFile(artifactPath(screenshotId), screenshot, { mode: 0o600 })
    const result = completeExecution(run.id, { screenshotId, pageUrl: page.url(), pageTitle: await page.title(),
      observation: (await page.locator("body").innerText()).slice(0, 12_000) })
    return { ...result, screenshotBase64: screenshot.toString("base64") }
  } catch (error) {
    return completeExecution(run.id, {}, error instanceof Error ? error.message.slice(0, 500) : "Browser execution failed.")
  } finally { locks.delete(run.workerId); if (worker) worker.busy = false }
}
async function withScreenshot(run: Run) {
  if (!run.screenshotId) return run
  try { return { ...run, screenshotBase64: (await readFile(artifactPath(run.screenshotId))).toString("base64") } }
  catch { return run }
}
