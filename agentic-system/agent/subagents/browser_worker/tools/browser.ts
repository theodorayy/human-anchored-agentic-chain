import { defineTool, toolOutput, toolOutputPart } from "eve/tools"
import { z } from "zod"
import { browserAction } from "../../../../lib/hac/policy"
import { delegateBrowser, dispatchBrowser } from "../../../../lib/hac/control-plane"
import { transaction } from "../../../../lib/hac/store"

export default defineTool({
  description: "Perform one browser action within the human mandate. Inspect returned screenshot pixels to choose coordinates. Approval and denials are enforced outside the model. Navigate only to the authorised URL you were given; never guess a domain.",
  // A flat object: Anthropic requires a tool's input schema to be type "object", which a
  // discriminated union is not. browserAction validates the exact shape in execute.
  inputSchema: z.object({
    kind: z.enum(["navigate", "inspect", "click", "type", "press", "scroll", "close"]),
    url: z.string().optional().describe("For navigate: the full URL."),
    x: z.number().int().optional().describe("For click: x coordinate in the 1280 by 800 viewport."),
    y: z.number().int().optional().describe("For click: y coordinate in the 1280 by 800 viewport."),
    text: z.string().optional().describe("For type: the exact text to enter."),
    key: z.enum(["Enter", "Tab", "Escape", "Backspace", "ArrowDown", "ArrowUp"]).optional().describe("For press: the key."),
    deltaY: z.number().int().optional().describe("For scroll: pixels to scroll, negative for up."),
    purpose: z.string().min(1).max(200).describe("Explain the specific UI control and why this action is needed, in plain language for the human approving it."),
  }),
  async execute(raw, ctx) {
    const { purpose, ...fields } = raw
    const input = { ...browserAction.parse(Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))), purpose }
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
