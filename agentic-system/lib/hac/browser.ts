import { chromium, type Browser, type BrowserContext, type Page } from "playwright"
import { mkdir, writeFile, readFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { randomUUID } from "node:crypto"
import { claimExecution, checkCurrentAuthority, completeExecution, HttpError } from "./control-plane"
import { identityProviderOrigins, scopeOrigins } from "./policy"
import type { Run } from "./types"
import { transaction } from "./store"
import { hasPlaceholder, openVault, redact, resolvePlaceholders } from "./vault"

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
        const request = route.request()
        const origin = new URL(request.url()).origin
        if (!scopeOrigins(active.currentRun.delegation.scope).includes(origin)) {
          // An identity provider is reachable only as the top-level page: a main-frame navigation
          // (each redirect hop is routed separately), or a main-frame request made while the page
          // is already on an identity-provider origin. Sub-frames and target-origin documents never reach it.
          const providers = identityProviderOrigins()
          const mainFrame = request.frame() === page.mainFrame()
          const topLevel = mainFrame && request.isNavigationRequest()
          const fromProviderPage = mainFrame && providers.includes(new URL(page.url()).origin)
          if (!providers.includes(origin) || !(topLevel || fromProviderPage)) return await route.abort("blockedbyclient")
        }
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
const escapeForRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
// Hides vault values before a screenshot: typed fields render as dots, and any text node
// that shows a value is covered. Returns a function that puts the page back as it was.
export async function maskForScreenshot(page: Page, values: Record<string, string>): Promise<() => Promise<void>> {
  const patterns = Object.values(values).map(v => v.trim()).filter(v => v.length >= 3)
    .sort((a, b) => b.length - a.length).map(v => escapeForRegex(v).replace(/\s+/g, "\\s+"))
  await page.evaluate((sources: string[]) => {
    const style = document.createElement("style")
    style.id = "hac-mask"
    style.textContent = "[data-hac-filled],[data-hac-mask]{-webkit-text-security:disc!important}[data-hac-cover]{background:#888!important;color:#888!important}"
    document.head.appendChild(style)
    if (!sources.length) return
    const pattern = new RegExp(sources.join("|"), "i")
    for (const field of Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")))
      if (pattern.test(field.value)) field.setAttribute("data-hac-mask", "1")
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const hits: Text[] = []
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      if (pattern.test(node.textContent || "") && !node.parentElement?.closest("script,style")) hits.push(node as Text)
    for (const node of hits) {
      const cover = document.createElement("span")
      cover.setAttribute("data-hac-cover", "1")
      cover.setAttribute("data-hac-filled", "1")
      node.replaceWith(cover)
      cover.appendChild(node)
    }
  }, patterns)
  return async () => {
    await page.evaluate(() => {
      document.getElementById("hac-mask")?.remove()
      for (const field of Array.from(document.querySelectorAll("[data-hac-mask]"))) field.removeAttribute("data-hac-mask")
      for (const cover of Array.from(document.querySelectorAll("[data-hac-cover]"))) cover.replaceWith(...Array.from(cover.childNodes))
    }).catch(() => undefined)
  }
}
// A form submitted with GET, or a redirect, can carry values in the address.
function redactUrl(href: string, values: Record<string, string>) {
  let decoded = href
  try { decoded = decodeURIComponent(href.replace(/\+/g, " ")) } catch { /* keep the raw address */ }
  return decoded === href ? redact(href, values) : redact(decoded, values) === decoded ? href : redact(decoded, values)
}
export async function executeBrowser(runId: string, capability: string) {
  const claim = claimExecution(runId, capability)
  if (!claim.execute) return withScreenshot(claim.run)
  const run = claim.run
  let worker: Worker | undefined
  // FreeID-released values for this task; only placeholders leave this function.
  const values = transaction(state => openVault(state, run.mandateId)) || {}
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
      if (!scopeOrigins(run.delegation.scope).includes(pageOrigin)) {
        if (!identityProviderOrigins().includes(pageOrigin)) throw new Error("Browser is outside its delegated origin.")
        if (["click", "type", "press"].includes(action.kind)) throw new Error("Identity provider pages are view-only for the agent")
      }
      const before = page.url()
      if (action.kind === "click") await page.mouse.click(action.x, action.y)
      if (action.kind === "type") {
        if (hasPlaceholder(action.text) && !Object.keys(values).length) throw new Error("No FreeID details are available for this task.")
        await page.keyboard.insertText(resolvePlaceholders(action.text, values))
        if (hasPlaceholder(action.text)) await page.evaluate(() => {
          const active = document.activeElement
          active?.setAttribute("data-hac-filled", "1")
          active?.closest("input, textarea, select")?.setAttribute("data-hac-filled", "1")
        })
      }
      if (action.kind === "press") await page.keyboard.press(action.key)
      // Give a click or key press a brief window to start a redirect so it appears in this run's evidence.
      if (action.kind === "click" || action.kind === "press") await page.waitForURL(url => url.href !== before, { timeout: 2_000, waitUntil: "domcontentloaded" }).catch(() => undefined)
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
        if (attempt >= 3 || !(error instanceof Error) || !/Execution context was destroyed/.test(error.message)) throw error
      }
    }
    checkCurrentAuthority(run)
    const screenshotId = randomUUID()
    const unmask = await maskForScreenshot(page, values)
    const screenshot = await page.screenshot({ type: "png" }).finally(unmask)
    await mkdir(resolve(/* turbopackIgnore: true */ process.env.HAC_DATA_DIR || ".hac", "screenshots"), { recursive: true, mode: 0o700 })
    await writeFile(artifactPath(screenshotId), screenshot, { mode: 0o600 })
    const finalOrigin = new URL(page.url()).origin
    const moved = !scopeOrigins(run.delegation.scope).includes(finalOrigin) && identityProviderOrigins().includes(finalOrigin) && ["click", "press"].includes(action.kind)
    const note = moved ? `The page moved to the identity provider ${finalOrigin}, which is view-only for the agent.\n` : ""
    const result = completeExecution(run.id, { screenshotId, pageUrl: redactUrl(page.url(), values), pageTitle: redact(await page.title(), values),
      observation: redact(note + await page.locator("body").innerText(), values).slice(0, 12_000) })
    return { ...result, screenshotBase64: screenshot.toString("base64") }
  } catch (error) {
    return completeExecution(run.id, {}, error instanceof Error ? redact(error.message, values).slice(0, 500) : "Browser execution failed.")
  } finally { locks.delete(run.workerId); if (worker) worker.busy = false }
}
async function withScreenshot(run: Run) {
  if (!run.screenshotId) return run
  try { return { ...run, screenshotBase64: (await readFile(artifactPath(run.screenshotId))).toString("base64") } }
  catch { return run }
}
