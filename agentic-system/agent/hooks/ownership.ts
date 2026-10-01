import { defineHook } from "eve/hooks"
import { bindEveSession } from "../../lib/hac/eve-session"

export default defineHook({ events: {
  "session.started": (_event, ctx) => {
    const principalId = ctx.session.auth.initiator?.principalId
    if (!principalId) throw new Error("An authenticated Principal is required.")
    bindEveSession(ctx.session.id, principalId, String(ctx.session.auth.initiator?.attributes.mandateId || ""))
  },
} })
