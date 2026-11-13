import { defineTool } from "eve/tools"
import { z } from "zod"
import { transaction } from "../../lib/hac/store"
import { requestIdentity } from "../../lib/hac/identity"

export function requestIdentityForSession(sessionId: string, principalId: string | undefined) {
  return transaction(state => {
    const binding = state.eveSessions.find(s => s.id === sessionId && s.principalId === principalId)
    if (!binding) throw new Error("Authenticated session binding required.")
    return requestIdentity(state, binding.principalId, binding.mandateId)
  })
}

export default defineTool({
  description: "Get the human's FreeID-verified identity details for this task as placeholders, such as {passport.family_name}. Returns pending until the human approves the release on their phone. Never returns the values themselves.",
  inputSchema: z.object({}),
  execute(_input, ctx) {
    return requestIdentityForSession(ctx.session.id, ctx.session.auth.current?.principalId)
  },
})
