import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import type { Grant, Mandate, Run, State, AuditEvent, BrowserAction } from "./types"

export const targetUrl = () => process.env.BROWSER_TARGET_URL || "https://clearance-review-demo.vercel.app"
export function identityProviderOrigins(): string[] {
  const scope = new URL(targetUrl()).origin
  const origins = new Set<string>()
  for (const entry of (process.env.IDENTITY_PROVIDER_ORIGINS || "").split(",")) {
    try { const origin = new URL(entry.trim()).origin; if (origin !== "null" && origin !== scope) origins.add(origin) } catch { /* ignore blank or invalid entries */ }
  }
  return [...origins]
}
export const mandateInput = z.object({
  title: z.string().trim().min(3).max(100),
  maxActions: z.number().int().min(1).max(200),
  requireApproval: z.boolean(),
  durationHours: z.number().int().min(1).max(24),
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
function signature(grant: Omit<Grant, "signature">, key: string) {
  return createHmac("sha256", key).update(JSON.stringify([
    grant.id, grant.parentId, grant.mandateId, grant.principalId, grant.agent,
    grant.scope.action, grant.scope.origin, grant.scope.maxActions, grant.scope.requireApproval, grant.expiresAt,
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
    root.scope.action !== "browser:use" || child.scope.action !== root.scope.action ||
    (m.requireApproval && !root.scope.requireApproval) || (root.scope.requireApproval && !child.scope.requireApproval))
    return deny("The child scope exceeds its parent authority.")
  if (run.action.kind === "navigate" && new URL(run.action.url).origin !== child.scope.origin) return deny("This destination is outside the delegated origin.")
  if (m.usedActions >= m.maxActions) return deny("The authorized browser action limit has been reached.")
  if (child.scope.requireApproval && isInteraction(run.action) && !run.approvedAt)
    return { decision: "require_approval", reason: "This browser interaction requires the Principal’s approval." }
  return { decision: "allow", reason: "Human authority, delegation, origin and action limit verified." }
}
