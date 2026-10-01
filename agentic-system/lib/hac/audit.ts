import { actionLabel } from "./policy"
import type { AuditEvent, State } from "./types"

// Enrich older receipts at read time using their recorded purpose. Keep stored
// events intact, and resolve against all runs rather than the UI's recent slice.
export function auditForPrincipal(state: State, principalId: string): AuditEvent[] {
  const runs = new Map(state.runs.filter(r => r.principalId === principalId).map(r => [r.id, r]))
  return state.audit.filter(event => event.principalId === principalId).map(event => {
    const run = event.runId ? runs.get(event.runId) : undefined
    return {
      ...event,
      detail: event.event === "browser.completed" && run?.summary ? run.summary : event.detail,
      actionDetail: event.actionDetail || (run ? actionLabel(run.action) : undefined),
      ...(event.event === "browser.completed" && run?.action.kind === "type"
        ? { typedText: event.typedText ?? run.action.text } : {}),
    }
  })
}
