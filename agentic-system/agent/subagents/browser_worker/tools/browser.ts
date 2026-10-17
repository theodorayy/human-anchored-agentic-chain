import { defineTool, toolOutput, toolOutputPart } from "eve/tools"
import { z } from "zod"
import { browserAction } from "../../../../lib/hac/policy"
import { delegateBrowser, dispatchBrowser } from "../../../../lib/hac/control-plane"
import { transaction } from "../../../../lib/hac/store"

export default defineTool({
  description: "Perform one browser action within the human mandate. Inspect returned screenshot pixels to choose coordinates. Approval and denials are enforced outside the model. Navigate only to the authorised URL you were given; never guess a domain.",
  inputSchema: browserAction.and(z.object({ purpose: z.string().min(1).max(200).describe("Explain the specific UI control and why this action is needed, in plain language for the human approving it.") })),
  async execute(input, ctx) {
    const rootId = ctx.session.parent?.rootSessionId
    if (!rootId) throw new Error("Browser worker must be delegated by an authenticated root session.")
    const binding = transaction(state => state.eveSessions.find(s => s.id === rootId))
    if (!binding) throw new Error("No human mandate is bound to this delegation.")
    const principal = { id: binding.principalId, name: "Principal", provider: "oidc" as const }
    // One browser per task, not per worker session: a fresh worker continues the same page
    // instead of reopening the site and losing what was entered.
    const run = delegateBrowser(principal, binding.mandateId, input, `task:${rootId}`, "eve", `${ctx.session.id}:${ctx.callId}`, rootId, input.purpose)
    const result = await dispatchBrowser(run)
    return { id: result.id, status: result.status, reason: result.reason, pageUrl: result.pageUrl,
      observation: result.observation, screenshotBase64: result.screenshotBase64 }
  },
  toModelOutput(output) {
    const { screenshotBase64, ...text } = output
    return toolOutput.content([
      toolOutputPart.text(JSON.stringify(text)),
      ...(screenshotBase64 ? [toolOutputPart.file(screenshotBase64, { mediaType: "image/png" })] : []),
    ])
  },
})
