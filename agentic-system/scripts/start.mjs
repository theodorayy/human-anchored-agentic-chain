import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { pruneHistory } from "./prune-history.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
process.chdir(root)
if (existsSync(".env.local")) process.loadEnvFile(".env.local")
const port = Number(process.env.EVE_NEXT_PRODUCTION_PORT || "4274")
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid Eve port.")
const children = new Set()
let stopping = false
function stop(code = 0) {
  if (stopping) return
  stopping = true
  process.exitCode = code
  for (const child of children) child.kill("SIGTERM")
  setTimeout(() => { for (const child of children) child.kill("SIGKILL") }, 8000).unref()
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop())
function launch(label, args, env) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit", env: { ...process.env, NODE_ENV: "production", ...env } })
  children.add(child)
  child.on("error", error => { console.error(`${label}: ${error.message}`); stop(1) })
  child.on("exit", code => { children.delete(child); if (!stopping) { console.error(`${label} exited (${code}).`); stop(code || 1) } })
}
launch("Eve", [resolve(".output/server/index.mjs")], { HOST: "127.0.0.1", NITRO_HOST: "127.0.0.1", PORT: String(port), NITRO_PORT: String(port) })
const deadline = Date.now() + 180_000
let ready = false
while (!stopping && Date.now() < deadline) {
  try { if ((await fetch(`http://127.0.0.1:${port}/eve/v1/health`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break } } catch {}
  await new Promise(resolve => setTimeout(resolve, 250))
}
if (!ready && !stopping) { console.error("Eve did not become ready."); stop(1) }
if (ready && !stopping) launch("Web", [resolve("node_modules/next/dist/bin/next"), "start", "--hostname", "0.0.0.0", "--port", process.env.PORT || "3003"], {})
// Eve never deletes its history, and the data volume is small. On the hosted runtime, check
// at start-up and every 10 minutes, and drop the oldest tasks' history once the volume is 70% full.
if (process.env.HAC_PRUNE_HISTORY === "true") {
  const prune = () => {
    try {
      const result = pruneHistory({ hacDir: resolve(process.env.HAC_DATA_DIR || ".hac"), eveDir: resolve(".eve/.workflow-data") })
      if (result.pruned) console.log(`History pruned: ${result.pruned} runs, ${result.forgotten} tasks removed from Recent tasks.`)
    } catch (error) { console.error(`History pruning failed: ${error instanceof Error ? error.message : error}`) }
  }
  prune()
  setInterval(prune, 600_000).unref()
}
