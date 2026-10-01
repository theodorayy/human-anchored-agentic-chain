import { transaction } from "./store"
import { audit } from "./policy"

export function bindEveSession(id: string, principalId: string, mandateId: string, title?: string) {
  transaction(state => {
    const existing = state.eveSessions.find(session => session.id === id)
    if (existing) {
      if (existing.principalId !== principalId || existing.mandateId !== mandateId)
        throw new Error("An Eve session cannot change its Principal or mandate.")
      if (!existing.title && title) existing.title = title.slice(0, 160)
      return
    }
    if (!state.mandates.some(m => m.id === mandateId && m.principalId === principalId))
      throw new Error("Invalid session mandate.")
    state.eveSessions.push({ id, principalId, mandateId, title: title?.slice(0, 160) })
    audit(state, { principalId, actor: "Eve runtime", event: "session.started", detail: `Root session ${id} bound to its human Principal.` })
  })
}
