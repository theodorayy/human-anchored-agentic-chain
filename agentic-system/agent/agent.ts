import { openai } from "@ai-sdk/openai"
import { defineAgent } from "eve"

// eve fixes the model at build time, so it is set here rather than from the environment.
// The runtime needs OPENAI_API_KEY.
export default defineAgent({
  model: openai("gpt-6.1-sol"),
  defaultTools: false,
})
