import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import type { Grant, Mandate, Run, State, AuditEvent, BrowserAction, Scope } from "./types"

export type Target = { name: string; url: string; origin: string }
// BROWSER_TARGETS is "Name=https://site,Name=https://site"; the first entry is the default.
// Without it, BROWSER_TARGET_URL is the only website.
export function targets(): Target[] {
  const list: Target[] = []
  for (const entry of (process.env.BROWSER_TARGETS || "").split(",")) {
    const at = entry.indexOf("=")
    if (at < 1) continue
    try {
      const url = new URL(entry.slice(at + 1).trim())
      if (!list.some(t => t.origin === url.origin)) list.push({ name: entry.slice(0, at).trim(), url: url.href, origin: url.origin })
    } catch { /* ignore invalid entries */ }
  }
  if (list.length) return list
  const url = new URL(process.env.BROWSER_TARGET_URL || "https://clearance-review-demo.vercel.app")
  return [{ name: url.hostname, url: url.href, origin: url.origin }]
}
export const targetUrl = () => targets()[0].url
export const scopeOrigins = (scope: Scope) => scope.origins ?? [scope.origin]
export function identityProviderOrigins(): string[] {
  const scope = new Set(targets().map(t => t.origin))
  const origins = new Set<string>()
  for (const entry of (process.env.IDENTITY_PROVIDER_ORIGINS || "").split(",")) {
    try { const origin = new URL(entry.trim()).origin; if (origin !== "null" && !scope.has(origin)) origins.add(origin) } catch { /* ignore blank or invalid entries */ }
  }
  return [...origins]
}
export const mandateInput = z.object({
  title: z.string().trim().min(3).max(100),
  maxActions: z.number().int().min(1).max(200),
  requireApproval: z.boolean(),
  durationHours: z.number().int().min(1).max(24),
  origins: z.array(z.string().max(200)).min(1).max(5).optional(),
})
export const browserAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), url: z.url().max(2000) }),
  z.object({ kind: z.literal("inspect") }),
  z.object({ kind: z.literal("click"), x: z.number().int().min(0).max(1279), y: z.number().int().min(0).max(799) }),
  z.object({ kind: z.literal("type"), text: z.string().min(1).max(2000) }),
  z.object({ kind: z.literal("press"), key: z.enum(["Enter", "Tab", "Escape", "Backspace", "ArrowDown", "ArrowUp"]) }),
  z.object({ kind: z.literal("scroll"), deltaY: z.number().int().min(-1600).max(1600) }),
  z.object({ kind: z.literal("close") }),
])
export const actionLabel = (action: BrowserAction) => action.kind === "navigate" ? `Open ${action.url}` : action.kind === "click" ? `Click at (${action.x}, ${action.y})` : action.kind === "type" ? `Type ${action.text.length} characters` : action.kind === "press" ? `Press ${action.key}` : action.kind === "scroll" ? "Scroll page" : action.kind === "close" ? "Close browser" : "Inspect page"
export const isInteraction = (a: BrowserAction) => ["click", "type", "press"].includes(a.kind)
// In "ask" mode only clicks wait for the Principal. Typing and key presses act on the field a
// click already focused, using details the Principal gave in the conversation.
export const needsApproval = (a: BrowserAction) => a.kind === "click"
function signature(grant: Omit<Grant, "signature">, key: string) {
  return createHmac("sha256", key).update(JSON.stringify([
    grant.id, grant.parentId, grant.mandateId, grant.principalId, grant.agent,
    grant.scope.action, grant.scope.origin, grant.scope.maxActions, grant.scope.requireApproval, grant.expiresAt,
    // Appended only when present, so grants signed before multi-site tasks still verify.
    ...(grant.scope.origins ? [grant.scope.origins] : []),
  ])).digest("hex")
}
export function signGrant(grant: Omit<Grant, "signature">, key: string): Grant {
  return { ...grant, signature: signature(grant, key) }
}
export function verifyGrant(grant: Grant, key: string) {
  if (!/^[a-f0-9]{64}$/.test(grant.signature)) return false
  return timingSafeEqual(Buffer.from(grant.signature, "hex"), Buffer.from(signature(grant, key), "hex"))
}
export function audit(state: State, event: Omit<AuditEvent, "id" | "at">) {
  state.audit.push({ ...event, id: randomUUID(), at: new Date().toISOString() })
}
export function evaluate(m: Mandate, run: Run, key: string, now = Date.now()): { decision: "allow" | "deny" | "require_approval"; reason: string } {
  const root = m.grant, child = run.delegation
  const deny = (reason: string) => ({ decision: "deny" as const, reason })
  if (!verifyGrant(root, key) || !verifyGrant(child, key)) return deny("Delegation signature is invalid.")
  if (root.parentId !== null || root.agent !== "root" || child.agent !== "browser-worker" || child.parentId !== root.id ||
    root.mandateId !== m.id || child.mandateId !== m.id || run.mandateId !== m.id ||
    root.principalId !== m.principalId || child.principalId !== m.principalId || run.principalId !== m.principalId)
    return deny("The delegation chain is not bound to this human mandate.")
  if (m.revokedAt) return deny("The human mandate has been revoked.")
  if ([m.expiresAt, root.expiresAt, child.expiresAt].some(v => !Number.isFinite(Date.parse(v)) || Date.parse(v) <= now)) return deny("The mandate or delegation has expired.")
  if (child.expiresAt > root.expiresAt || root.expiresAt > m.expiresAt || root.scope.maxActions > m.maxActions ||
    child.scope.maxActions > root.scope.maxActions || child.scope.origin !== root.scope.origin || root.scope.origin !== m.origin ||
    JSON.stringify(scopeOrigins(child.scope)) !== JSON.stringify(scopeOrigins(root.scope)) ||
    JSON.stringify(scopeOrigins(root.scope)) !== JSON.stringify(m.origins ?? [m.origin]) ||
    root.scope.action !== "browser:use" || child.scope.action !== root.scope.action ||
    (m.requireApproval && !root.scope.requireApproval) || (root.scope.requireApproval && !child.scope.requireApproval))
    return deny("The child scope exceeds its parent authority.")
  const allowed = scopeOrigins(child.scope)
  if (run.action.kind === "navigate" && !allowed.includes(new URL(run.action.url).origin))
    return deny(allowed.length === 1 ? `This destination is outside the delegated origin. The only authorised website is ${allowed[0]}.` : `This destination is outside the delegated origins. The authorised websites are ${allowed.join(", ")}.`)
  if (m.usedActions >= m.maxActions) return deny("The authorized browser action limit has been reached.")
  if (child.scope.requireApproval && needsApproval(run.action) && !run.approvedAt)
    return { decision: "require_approval", reason: "This click requires the Principal’s approval." }
  return { decision: "allow", reason: "Human authority, delegation, origin and action limit verified." }
}
