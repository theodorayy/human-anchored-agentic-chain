import { defineTool } from "eve/tools"
import { z } from "zod"
import { transaction } from "../../lib/hac/store"
import { targets } from "../../lib/hac/policy"
export default defineTool({
  description: "Read this session's human-issued mandate and recent browser execution outcomes.",
  inputSchema: z.object({}),
  execute(_input, ctx) {
    return transaction(state => {
      const binding = state.eveSessions.find(s => s.id === ctx.session.id && s.principalId === ctx.session.auth.current?.principalId)
      if (!binding) throw new Error("Authenticated session binding required.")
      const m = state.mandates.find(m => m.id === binding.mandateId)!
      const granted = m.origins ?? [m.origin]
      const websites = targets().filter(t => granted.includes(t.origin)).map(t => ({ name: t.name, targetUrl: t.url }))
      return { id: m.id, title: m.title, websites, targetUrl: websites[0]?.targetUrl,
        remainingActions: m.maxActions - m.usedActions, requireApproval: m.requireApproval, expiresAt: m.expiresAt, revokedAt: m.revokedAt,
        approvalInstructions: "Propose the next interaction with browser_worker. Only a browser result with status approval creates an approval card in this HAC workspace's right sidebar. Never direct the human to an approval panel in the target website.",
        pendingApprovals: state.runs.filter(r => r.mandateId === m.id && r.status === "approval")
          .map(r => ({ id: r.id, workerId: r.workerId, action: r.action, reason: r.reason })),
        recentActions: state.runs.filter(r => r.mandateId === m.id).slice(-8)
          .map(r => ({ id: r.id, workerId: r.workerId, action: r.action, status: r.status, reason: r.reason, pageUrl: r.pageUrl })) }
    })
  },
})
