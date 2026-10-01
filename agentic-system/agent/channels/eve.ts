import { eveChannel } from "eve/channels/eve"
import { ForbiddenError, type AuthFn } from "eve/channels/auth"
import { principalFor, requireSameOrigin, eveAvailable } from "../../lib/hac/auth"
import { transaction } from "../../lib/hac/store"
import { bindEveSession } from "../../lib/hac/eve-session"

const auth: AuthFn<Request> = request => {
  if (!eveAvailable()) return null
  if (request.method !== "GET") requireSameOrigin(request)
  const principal = principalFor(request)
  if (!principal) return null
  const sessionId = new URL(request.url).pathname.match(/\/session\/([^/]+)/)?.[1]
  if (sessionId && !transaction(state => state.eveSessions.some(s => s.id === sessionId && s.principalId === principal.id)))
    throw new ForbiddenError({ message: "This session is not owned by the current Principal." })
  const mandateId = sessionId
    ? transaction(state => state.eveSessions.find(s => s.id === sessionId)?.mandateId)
    : request.headers.get("x-hac-mandate")
  if (!mandateId || !transaction(state => state.mandates.some(m => m.id === mandateId && m.principalId === principal.id)))
    throw new ForbiddenError({ message: "Select a human-issued mandate before starting an agent session." })
  return { principalId: principal.id, principalType: "user", authenticator: "hac-session",
    attributes: { name: principal.name, provider: principal.provider, mandateId } }
}
const channel = eveChannel({ auth })
const authenticatedChannel = {
  ...channel,
  routes: channel.routes.map(route => {
    if (route.transport === "websocket" || route.method !== "POST" || route.path !== "/eve/v1/session") return route
    return { ...route, handler: async (...args: Parameters<typeof route.handler>) => {
      const response = await route.handler(...args)
      if (response.ok) {
        // Eve can acknowledge creation before session.started runs. Persist the
        // ownership binding before the client can open its first event stream.
        const principal = principalFor(args[0])
        const mandateId = args[0].headers.get("x-hac-mandate")
        const { sessionId } = await response.clone().json() as { sessionId: string }
        if (!principal || !mandateId || !sessionId) throw new Error("Missing session ownership.")
        const taskHeader = args[0].headers.get("x-hac-task")
        let title: string | undefined
        try { title = taskHeader ? decodeURIComponent(taskHeader).slice(0, 160) : undefined } catch { /* Optional display label. */ }
        bindEveSession(sessionId, principal.id, mandateId, title)
      }
      return response
    } }
  }),
}
export default authenticatedChannel
