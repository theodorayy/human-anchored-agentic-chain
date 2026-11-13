import { z, ZodError } from "zod"
import { readFile } from "node:fs/promises"
import { requirePrincipal, requireSameOrigin, demoSession, logout, demoAvailable, oidcAvailable, eveAvailable, appUrl, cookieHeader } from "@/lib/hac/auth"
import { beginLogin, finishLogin } from "@/lib/hac/oidc"
import { beginRelease, finishRelease, identityStatus } from "@/lib/hac/identity"
import { createMandate, revokeMandate, deleteTask, delegateBrowser, dispatchBrowser, reviewRun, HttpError } from "@/lib/hac/control-plane"
import { targetUrl, targets, identityProviderOrigins } from "@/lib/hac/policy"
import { transaction } from "@/lib/hac/store"
import { auditForPrincipal } from "@/lib/hac/audit"
import { serverlessHost } from "@/lib/hac/deployment"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
function publicJson(value: unknown, status = 200) {
  const text = JSON.stringify(value, (key, v) => ["signature", "signingKey"].includes(key) ? undefined : v)
  return new Response(text, { status, headers: { "content-type": "application/json", "cache-control": "no-store" } })
}
async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const path = (await context.params).path.join("/")
  try {
    if (request.method === "GET" && path === "health") return publicJson({ ok: true, runtimeAvailable: !serverlessHost() })
    if (request.method === "POST" && ["auth/logout", "auth/demo"].includes(path)) {
      requireSameOrigin(request)
      return new Response(null, { status: 204, headers: { "set-cookie": path === "auth/logout" ? logout(request) : demoSession(), "cache-control": "no-store" } })
    }
    if (request.method === "GET") {
      if (path === "auth/login") return await beginLogin()
      if (path === "auth/callback") return await finishLogin(request)
      if (path === "state") {
        const principal = requirePrincipal(request)
        if (serverlessHost()) return publicJson({ principal, mandates: [], runs: [], audit: [], sessions: [],
          demoAvailable: false, oidcAvailable: oidcAvailable(), eveAvailable: false, runtimeAvailable: false, targetUrl: targetUrl(), targets: targets(), identityProviderOrigins: identityProviderOrigins() })
        const data = transaction(state => ({
          mandates: state.mandates.filter(m => m.principalId === principal?.id).map(m => ({ ...m, identity: identityStatus(state, m.id) })),
          runs: state.runs.filter(r => r.principalId === principal?.id).slice(-100).reverse(),
          audit: auditForPrincipal(state, principal.id).slice(-200).reverse(),
          sessions: state.eveSessions.filter(s => s.principalId === principal?.id).map(s => ({ id: s.id, mandateId: s.mandateId, title: s.title })),
        }))
        return publicJson({ ...data, observedAt: Date.now(), principal, demoAvailable: demoAvailable(), oidcAvailable: oidcAvailable(), eveAvailable: eveAvailable(), runtimeAvailable: true, targetUrl: targetUrl(), targets: targets(), identityProviderOrigins: identityProviderOrigins() })
      }
    }
    if (serverlessHost()) {
      requirePrincipal(request)
      throw new HttpError(503, "Your identity is connected. The agent runtime is not connected yet.")
    }
    const { executeBrowser, artifactPath, closeMandateBrowsers } = await import("@/lib/hac/browser")
    if (request.method === "GET") {
      const principal = requirePrincipal(request)
      if (path === "identity/start") {
        const mandateId = z.string().uuid().parse(new URL(request.url).searchParams.get("mandate"))
        return await beginRelease(principal, mandateId)
      }
      if (path === "freeid/callback") return await finishRelease(request, principal)
      if (path === "audit/export") {
        const events = transaction(state => auditForPrincipal(state, principal.id))
        return new Response(JSON.stringify(events, null, 2), { headers: { "content-type": "application/json", "content-disposition": 'attachment; filename="hac-audit.json"', "cache-control": "no-store" } })
      }
      const screenshot = path.match(/^screenshots\/([^/]+)$/)
      if (screenshot) {
        const id = z.string().uuid().parse(screenshot[1])
        if (!transaction(state => state.runs.some(r => r.principalId === principal.id && r.screenshotId === id))) throw new HttpError(404, "Screenshot not found.")
        return new Response(await readFile(artifactPath(id)), { headers: { "content-type": "image/png", "cache-control": "private, no-store" } })
      }
    }
    if (request.method === "POST") {
      if (path === "executor/browser") {
        const { runId } = z.object({ runId: z.string().min(1).max(200) }).parse(await request.json())
        return publicJson(await executeBrowser(runId, request.headers.get("authorization")?.replace(/^Bearer /, "") || ""))
      }
      requireSameOrigin(request)
      const principal = requirePrincipal(request)
      if (path === "mandates") return publicJson(createMandate(principal, await request.json()), 201)
      const revoke = path.match(/^mandates\/([^/]+)\/revoke$/)
      if (revoke) {
        const mandate = revokeMandate(principal, revoke[1])
        await closeMandateBrowsers(mandate.id)
        return publicJson(mandate)
      }
      const removal = path.match(/^tasks\/([^/]+)\/delete$/)
      if (removal) {
        const removed = deleteTask(principal, decodeURIComponent(removal[1]))
        await closeMandateBrowsers(removed.mandateId)
        return publicJson(removed)
      }
      if (path === "browser/preview") {
        const { mandateId, url } = z.object({ mandateId: z.string().uuid(), url: z.url() }).parse(await request.json())
        const id = z.string().uuid().parse(request.headers.get("idempotency-key"))
        const run = delegateBrowser(principal, mandateId, { kind: "navigate", url }, `preview:${principal.id}:${mandateId}`, "manual", id)
        return publicJson(await dispatchBrowser(run), 201)
      }
      const review = path.match(/^runs\/(.+)\/(approve|reject)$/)
      if (review) {
        const run = reviewRun(principal, decodeURIComponent(review[1]), review[2] === "approve")
        return publicJson(review[2] === "reject" ? run : await dispatchBrowser(run))
      }
    }
    throw new HttpError(404, "Route not found.")
  } catch (error) {
    if (["auth/login", "auth/callback"].includes(path)) {
      console.error("HAC sign-in failed", error instanceof Error ? error.message : "Unknown error")
      return new Response(null, { status: 302, headers: { location: `${appUrl()}/?error=signin`, "set-cookie": cookieHeader("hac_oidc", "", 0), "cache-control": "no-store" } })
    }
    if (error instanceof ZodError) return publicJson({ error: error.issues.map(i => i.message).join(" ") }, 400)
    if (error instanceof HttpError) return publicJson({ error: error.message }, error.status)
    console.error("HAC request failed", error instanceof Error ? error.message : "Unknown error")
    return publicJson({ error: "The request could not be completed. Check the server configuration and try again." }, 500)
  }
}
export { handle as GET, handle as POST }
