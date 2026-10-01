// Used only by the isolated runtime test fixture; never imported by the app agent.
import { MockLanguageModelV3 } from "ai/test"
export const model = new MockLanguageModelV3({
  provider: "openai",
  modelId: "gpt-5.4-mini",
  doStream: async options => {
    const child = options.tools?.some(tool => tool.type === "function" && tool.name === "browser")
    const toolName = child ? "browser" : "browser_worker"
    const hasResult = options.prompt.some(message => message.role === "tool" && message.content.some(part => part.type === "tool-result" && part.toolName === toolName))
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] })
      if (!hasResult) controller.enqueue({ type: "tool-call", toolCallId: child ? "navigate-fixture" : "delegate-fixture", toolName,
        input: JSON.stringify(child ? { kind: "navigate", url: "https://clearance-review-demo.vercel.app", purpose: "Open the authorized demo review queue." } : { message: "Open the Clearance demo and report its page title. Do not interact with records." }) })
      else {
        controller.enqueue({ type: "text-start", id: "text" })
        controller.enqueue({ type: "text-delta", id: "text", delta: "Fixture response: browser task processed." })
        controller.enqueue({ type: "text-end", id: "text" })
      }
      controller.enqueue({ type: "finish", finishReason: { unified: hasResult ? "stop" : "tool-calls", raw: hasResult ? "stop" : "tool_calls" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } })
      controller.close()
    } }) }
  },
})
