import { defineAgent } from "eve"
export default defineAgent({
  description: "Operate the authorized website through screenshots and bounded browser actions. Pass a specific subtask; this worker has isolated browser state.",
  model: process.env.EVE_BROWSER_MODEL || process.env.EVE_MODEL || "anthropic/claude-sonnet-5.5",
  // One browser action per step: a click awaiting approval must settle before the typing that follows it.
  modelOptions: { providerOptions: { anthropic: { disableParallelToolUse: true } } },
  defaultTools: false,
})
