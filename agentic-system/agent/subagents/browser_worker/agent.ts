import { defineAgent } from "eve"
export default defineAgent({
  description: "Operate the authorized website through screenshots and bounded browser actions. Pass a specific subtask; this worker has isolated browser state.",
  model: process.env.EVE_BROWSER_MODEL || process.env.EVE_MODEL || "openai/gpt-5.4-mini",
  defaultTools: false,
})
