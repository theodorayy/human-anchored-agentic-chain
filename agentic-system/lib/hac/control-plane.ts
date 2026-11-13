import { randomUUID } from "node:crypto"
import { transaction } from "./store"
import { audit, evaluate, mandateInput, browserAction, signGrant, targets, actionLabel } from "./policy"
import type { Principal, Run } from "./types"
import { dropVault } from "./vault"

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
function owned<T extends { id: string; principalId: string }>(rows: T[], id: string, principal: Principal): T {
  const row = rows.find(r => r.id === id && r.principalId === principal.id)
  if (!row) throw new HttpError(404, "Record not found.")
  return row
}
export function createMandate(principal: Principal, input: unknown) {
  const parsed = mandateInput.parse(input)
  return transaction(state => {
    const id = randomUUID(), createdAt = new Date().toISOString()
    const expiresAt = new Date(Date.now() + parsed.durationHours * 3_600_000).toISOString()
    const sites = targets()
    const requested = parsed.origins ?? [sites[0].origin]
    const origins = sites.filter(t => requested.includes(t.origin)).map(t => t.origin)
    if (origins.length !== new Set(requested).size) throw new HttpError(400, "A requested website is not available for tasks.")
    const origin = origins[0]
    const scope = { action: "browser:use" as const, origin, ...(origins.length > 1 ? { origins } : {}), maxActions: parsed.maxActions, requireApproval: parsed.requireApproval }
    const grant = signGrant({ id: randomUUID(), parentId: null, mandateId: id, principalId: principal.id,
      agent: "root", scope, expiresAt }, state.signingKey)
    const mandate = { id, principalId: principal.id, title: parsed.title, accountableParty: "Principal · personal capacity",
      maxActions: parsed.maxActions, usedActions: 0, requireApproval: parsed.requireApproval,
      origin, ...(origins.length > 1 ? { origins } : {}), createdAt, expiresAt, revokedAt: null, grant }
    state.mandates.push(mandate)
    audit(state, { principalId: principal.id, mandateId: id, actor: "Principal", event: "mandate.created", detail: `Granted ${parsed.maxActions} browser actions at ${origins.join(", ")}. Interactions ${parsed.requireApproval ? "require approval" : "are pre-authorized"}.` })
    return mandate
  })
}
export function revokeMandate(principal: Principal, id: string) {
  return transaction(state => {
    const m = owned(state.mandates, id, principal)
    if (!m.revokedAt) {
      m.revokedAt = new Date().toISOString()
      dropVault(state, id)
      audit(state, { principalId: principal.id, mandateId: id, actor: "Principal", event: "mandate.revoked", detail: "Descendant authority revoked. Future browser actions will be denied." })
      for (const run of state.runs.filter(r => r.mandateId === id && ["approval", "queued"].includes(r.status))) {
        run.status = "denied"; run.reason = "The human mandate has been revoked."
        audit(state, { principalId: principal.id, runId: run.id, mandateId: id, actor: "Control plane", event: "policy.deny", detail: run.reason })
      }
    }
    return m
  })
}
export function deleteTask(principal: Principal, sessionId: string) {
  return transaction(state => {
    const index = state.eveSessions.findIndex(s => s.id === sessionId && s.principalId === principal.id)
    if (index < 0) throw new HttpError(404, "Task not found.")
    const [session] = state.eveSessions.splice(index, 1)
    dropVault(state, session.mandateId)
    const m = state.mandates.find(x => x.id === session.mandateId && x.principalId === principal.id)
    if (m && !m.revokedAt) {
      m.revokedAt = new Date().toISOString()
      for (const run of state.runs.filter(r => r.mandateId === m.id && ["approval", "queued"].includes(r.status))) {
        run.status = "denied"; run.reason = "The task was deleted."
      }
    }
    audit(state, { principalId: principal.id, mandateId: session.mandateId, actor: "Principal", event: "task.deleted", detail: "Task deleted. Its browser access ended; its audit record is kept." })
    return { id: session.id, mandateId: session.mandateId }
  })
}
export function delegateBrowser(principal: Principal, mandateId: string, input: unknown, workerId: string, mode: Run["mode"], id: string = randomUUID(), rootSessionId?: string, summary?: string) {
  const action = browserAction.parse(input)
  return transaction(state => {
    const previous = state.runs.find(r => r.id === id)
    if (previous) {
      if (previous.principalId !== principal.id || previous.mandateId !== mandateId || previous.workerId !== workerId || JSON.stringify(previous.action) !== JSON.stringify(action)) throw new HttpError(409, "Request ID is bound to another action.")
      return previous
    }
    const m = owned(state.mandates, mandateId, principal)
    if (rootSessionId && !state.eveSessions.some(s => s.id === rootSessionId && s.principalId === principal.id && s.mandateId === mandateId))
      throw new HttpError(403, "Browser task is not bound to this session's permissions.")
    if (!["inspect", "close"].includes(action.kind) && state.runs.some(r => r.workerId === workerId && r.status === "approval")) throw new HttpError(409, "Resolve this worker’s pending approval before another browser action.")
    const delegation = signGrant({ id: randomUUID(), parentId: m.grant.id, mandateId: m.id,
      principalId: principal.id, agent: "browser-worker", expiresAt: m.expiresAt, scope: { ...m.grant.scope },
    }, state.signingKey)
    const run: Run = { id, principalId: principal.id, mandateId, workerId, action, mode, rootSessionId, summary: summary?.slice(0, 200), status: "queued",
      reason: "Delegated to the browser worker.", createdAt: new Date().toISOString(), approvedAt: null, delegation }
    state.runs.push(run)
    audit(state, { principalId: principal.id, runId: id, mandateId, actor: "Root agent", event: "task.delegated", detail: run.summary || actionLabel(action) })
    return run
  })
}
// Atomic claim prevents concurrent calls or durable retries from repeating an effect.
export function claimExecution(runId: string, capability: string) {
  return transaction(state => {
    const run = state.runs.find(r => r.id === runId)
    if (!run || capability !== run.delegation.signature) throw new HttpError(403, "Invalid executor capability.")
    if (run.status !== "queued") return { run, execute: false }
    const m = state.mandates.find(m => m.id === run.mandateId)!
    const result = evaluate(m, run, state.signingKey)
    run.reason = result.reason
    audit(state, { principalId: run.principalId, runId, mandateId: m.id, actor: "Control plane", event: `policy.${result.decision}`, detail: result.reason })
    if (result.decision === "deny") run.status = "denied"
    else if (result.decision === "require_approval") run.status = "approval"
    else { run.status = "executing"; m.usedActions++ }
    return { run, execute: run.status === "executing" }
  })
}
export function checkCurrentAuthority(run: Run) {
  return transaction(state => {
    const m = state.mandates.find(m => m.id === run.mandateId)!
    // This action already reserved one slot at admission.
    const result = evaluate({ ...m, usedActions: Math.max(0, m.usedActions - 1) }, run, state.signingKey)
    if (result.decision !== "allow") throw new Error(result.reason)
  })
}
export function completeExecution(id: string, result: Pick<Run, "pageUrl" | "pageTitle" | "observation" | "screenshotId">, error?: string) {
  return transaction(state => {
    const run = state.runs.find(r => r.id === id)!
    if (run.status !== "executing") return run
    Object.assign(run, result)
    run.status = error ? "failed" : "completed"
    run.reason = error || "Browser action completed within delegated authority."
    audit(state, { principalId: run.principalId, runId: id, mandateId: run.mandateId, actor: "Browser worker", event: error ? "execution.failed" : "browser.completed", detail: error || run.summary || actionLabel(run.action), actionDetail: actionLabel(run.action),
      ...(!error && run.action.kind === "type" ? { typedText: run.action.text } : {}) })
    return run
  })
}
export function reviewRun(principal: Principal, id: string, approve: boolean) {
  return transaction(state => {
    const run = owned(state.runs, id, principal)
    if (run.status !== "approval") throw new HttpError(409, "This action is no longer awaiting approval.")
    audit(state, { principalId: principal.id, runId: id, mandateId: run.mandateId, actor: "Principal", event: approve ? "approval.granted" : "approval.rejected", detail: approve ? `Approved exact action: ${actionLabel(run.action)}. Authority will be rechecked.` : "Declined this browser action." })
    if (approve) { run.approvedAt = new Date().toISOString(); run.status = "queued" }
    else { run.status = "denied"; run.reason = "The Principal declined this browser action." }
    return run
  })
}
export async function dispatchBrowser(run: Run): Promise<Run & { screenshotBase64?: string }> {
  const response = await fetch(`${process.env.APP_URL || "http://localhost:3003"}/api/executor/browser`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${run.delegation.signature}` },
    body: JSON.stringify({ runId: run.id }), signal: AbortSignal.timeout(45_000),
  })
  if (!response.ok) throw new HttpError(502, "The browser executor could not complete the request. Check its recorded status before continuing.")
  return await response.json()
}
