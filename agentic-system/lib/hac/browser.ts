import { chromium, type Browser, type BrowserContext, type Page } from "playwright"
import { mkdir, writeFile, readFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { randomUUID } from "node:crypto"
import { claimExecution, checkCurrentAuthority, completeExecution, HttpError } from "./control-plane"
import { identityProviderOrigins, scopeOrigins } from "./policy"
import type { Run } from "./types"
import { transaction } from "./store"
import { hasPlaceholder, openVault, redact, resolvePlaceholders, valuePatterns } from "./vault"

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
// Masking runs in an isolated script world: the page shares the DOM but none of this
// world's JavaScript, so a site's own scripts can never see the values being matched.
async function inIsolatedWorld<T>(page: Page, script: string, arg: unknown): Promise<T> {
  const cdp = await page.context().newCDPSession(page)
  try {
    const { frameTree } = await cdp.send("Page.getFrameTree")
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "hac-mask" })
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
      expression: `(${script})(${JSON.stringify(arg)})`, contextId: executionContextId, returnByValue: true, awaitPromise: true })
    if (exceptionDetails) throw new Error("Could not hide FreeID details on this page.")
    return result.value as T
  } finally { await cdp.detach().catch(() => undefined) }
}
// Plain JavaScript strings, not functions, so no compiler helper ends up in the page.
const ROOTS = `function roots() {
  const list = [document]
  const walk = root => { for (const el of root.querySelectorAll("*")) if (el.shadowRoot) { list.push(el.shadowRoot); walk(el.shadowRoot) } }
  walk(document)
  return list
}`
const MASK = `(({ sources }) => {
  ${ROOTS}
  const css = "[data-hac-filled],[data-hac-mask]{-webkit-text-security:disc!important}[data-hac-cover]{background:#888!important;color:#888!important;fill:#888!important}iframe[data-hac-cover]{visibility:hidden!important}"
  for (const root of roots()) {
    const style = document.createElement("style")
    style.setAttribute("data-hac-style", "1")
    style.textContent = css
    ;(root === document ? (document.head || document.documentElement) : root).appendChild(style)
  }
  if (!sources.length) return
  const pattern = new RegExp(sources.join("|"), "iu")
  for (const root of roots()) {
    for (const field of root.querySelectorAll("input, textarea"))
      if (pattern.test(field.value) || pattern.test(field.placeholder || "")) field.setAttribute("data-hac-mask", "1")
    for (const frame of root.querySelectorAll("iframe")) frame.setAttribute("data-hac-cover", "1")
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const hits = []
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      if (pattern.test(node.textContent || "") && !(node.parentElement && node.parentElement.closest("script,style,[data-hac-cover]"))) hits.push(node)
    for (const node of hits) {
      const cover = document.createElement("span")
      cover.setAttribute("data-hac-cover", "1")
      node.replaceWith(cover)
      cover.appendChild(node)
    }
  }
})`
const EXPOSED = `(({ sources }) => {
  ${ROOTS}
  if (!sources.length) return false
  const pattern = new RegExp(sources.join("|"), "iu")
  for (const root of roots()) {
    for (const field of root.querySelectorAll("input, textarea"))
      if ((pattern.test(field.value) || pattern.test(field.placeholder || "")) && !field.matches("[data-hac-mask],[data-hac-filled]")) return true
    for (const frame of root.querySelectorAll("iframe")) if (!frame.matches("[data-hac-cover]")) return true
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      if (pattern.test(node.textContent || "") && !(node.parentElement && node.parentElement.closest("script,style,[data-hac-cover]"))) return true
  }
  return false
})`
const UNMASK = `(() => {
  ${ROOTS}
  for (const root of roots()) {
    for (const el of root.querySelectorAll("[data-hac-style]")) el.remove()
    for (const el of root.querySelectorAll("[data-hac-mask]")) el.removeAttribute("data-hac-mask")
    for (const el of root.querySelectorAll("iframe[data-hac-cover]")) el.removeAttribute("data-hac-cover")
    for (const el of root.querySelectorAll("[data-hac-cover]")) el.replaceWith(...el.childNodes)
  }
})`
// Hides vault values before a screenshot: typed fields render as dots, and text, fields and
// frames that show a value are covered. Returns a function that puts the page back.
export async function maskForScreenshot(page: Page, values: Record<string, string>): Promise<() => Promise<void>> {
  const sources = valuePatterns(values).map(p => p.source)
  await inIsolatedWorld(page, MASK, { sources })
  return async () => { await inIsolatedWorld(page, UNMASK, {}).catch(() => undefined) }
}
// True if the page still shows a value outside the masking (for example, a script undid it).
export async function stillExposed(page: Page, values: Record<string, string>): Promise<boolean> {
  return inIsolatedWorld<boolean>(page, EXPOSED, { sources: valuePatterns(values).map(p => p.source) })
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
  let values: Record<string, string> = {}
  if (locks.has(run.workerId)) return completeExecution(run.id, {}, "This browser is handling another action. Wait before continuing.")
  locks.add(run.workerId)
  try {
    values = transaction(state => openVault(state, run.mandateId)) || {}
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
    let exposed = true, screenshot: Buffer
    try {
      screenshot = await page.screenshot({ type: "png" })
      // Fail closed: a page that re-renders a value after masking gets no screenshot.
      exposed = await stillExposed(page, values)
    } finally { await unmask() }
    if (exposed) throw new Error("This page shows FreeID details that could not be hidden, so no screenshot was kept.")
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
