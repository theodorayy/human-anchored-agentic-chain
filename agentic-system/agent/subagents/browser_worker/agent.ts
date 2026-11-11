import { openai } from "@ai-sdk/openai"
import { defineAgent } from "eve"
export default defineAgent({
  description: "Operate the authorized website through screenshots and bounded browser actions. Pass a specific subtask; this worker has isolated browser state.",
  model: openai("gpt-6.1-sol"),
  // One browser action per step: a click awaiting approval must settle before the typing that follows it.
  modelOptions: { providerOptions: { openai: { parallelToolCalls: false } } },
  defaultTools: false,
})
