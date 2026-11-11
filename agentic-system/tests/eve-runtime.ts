import { spawn } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, rmSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { randomUUID } from "node:crypto"
import assert from "node:assert/strict"
import { Client } from "eve/client"
import { createSession } from "../lib/hac/auth"
import { createMandate, revokeMandate } from "../lib/hac/control-plane"
import { transaction } from "../lib/hac/store"

if (existsSync(".env.local")) process.loadEnvFile(".env.local")
const appRoot = process.cwd()
mkdirSync(".hac", { recursive: true })
const fixture = mkdtempSync(resolve(".hac/runtime-fixture-"))
cpSync("agent", `${fixture}/agent`, { recursive: true })
symlinkSync(resolve("lib"), `${fixture}/lib`, "dir")
writeFileSync(`${fixture}/package.json`, JSON.stringify({ name: "hac-runtime-fixture", type: "module", private: true, dependencies: { eve: "0.53.1" } }))
cpSync("tests/fixtures/eve-model.ts", `${fixture}/fixture-model.ts`)
for (const [path, modelImport] of [["agent/agent.ts", "../fixture-model"], ["agent/subagents/browser_worker/agent.ts", "../../../fixture-model"]]) {
  const file = `${fixture}/${path}`
  writeFileSync(file, `import { model } from "${modelImport}"\n` + readFileSync(file, "utf8").replace(/model:.*,/g, "model,"))
}
const principal = { id: `runtime-test:${randomUUID()}`, name: "Runtime fixture", provider: "demo" as const }
const mandate = createMandate(principal, { title: "Runtime integration test", maxActions: 5, durationHours: 1, requireApproval: true })
const cookie = createSession(principal).split(";")[0]
let logs = ""
const child = spawn(process.execPath, [resolve("node_modules/eve/bin/eve.js"), "dev", "--no-ui", "--host", "127.0.0.1", "--port", "3017"], {
  cwd: fixture, env: { ...process.env, OPENAI_API_KEY: "fixture-only-no-provider-calls", HAC_DATA_DIR: resolve(process.env.HAC_DATA_DIR || ".hac"), PATH: `${dirname(process.execPath)}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"],
})
child.stdout.on("data", b => { logs = (logs + b.toString()).slice(-12000) })
child.stderr.on("data", b => { logs = (logs + b.toString()).slice(-12000) })
const client = new Client({ host: "http://127.0.0.1:3017", headers: { cookie, origin: process.env.APP_URL || "http://localhost:3003", "x-hac-mandate": mandate.id } })
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
try {
  let healthy = false
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Fixture failed to boot: ${logs}`)
    try { await client.health(); healthy = true; break } catch { await sleep(500) }
  }
  assert.ok(healthy, `Eve did not become ready: ${logs}`)
  const { session, response } = await client.sessions.create({ message: "Inspect Clearance." })
  await response.result()
  let completed = false
  for (let i = 0; i < 100; i++) {
    const runs = transaction(state => state.runs.filter(r => r.principalId === principal.id))
    if (runs.some(r => r.status === "completed" && r.pageUrl?.includes("clearance-review-demo"))) { completed = true; break }
    if (runs.some(r => r.status === "failed" || r.status === "denied")) throw new Error(JSON.stringify(runs.map(r => ({ status: r.status, reason: r.reason }))))
    await sleep(500)
  }
  assert.ok(completed, `No completed browser action from Eve: ${logs}`)
  const other = new Client({ host: "http://127.0.0.1:3017", headers: { cookie: createSession({ ...principal, id: "different-fixture-user" }).split(";")[0], origin: process.env.APP_URL || "http://localhost:3003" } })
  await assert.rejects(() => other.sessions.attach(session.state.sessionId).send("Read this conversation"))
  console.log("PASS: real Eve session → declared browser subagent → control plane → Clearance screenshot; cross-user session access rejected. Model outputs supplied by a test fixture.")
} catch (error) { console.error(logs); throw error }
finally {
  revokeMandate(principal, mandate.id)
  await fetch(`${process.env.APP_URL || "http://localhost:3003"}/api/mandates/${mandate.id}/revoke`, { method: "POST", headers: { cookie, origin: process.env.APP_URL || "http://localhost:3003" } }).catch(() => {})
  child.kill("SIGTERM")
  transaction(state => {
    state.runs = state.runs.filter(r => r.principalId !== principal.id)
    state.mandates = state.mandates.filter(m => m.principalId !== principal.id)
    state.eveSessions = state.eveSessions.filter(s => s.principalId !== principal.id)
    state.audit = state.audit.filter(a => a.principalId !== principal.id)
    state.sessions = state.sessions.filter(s => ![principal.id, "different-fixture-user"].includes(s.principal.id))
  })
  await sleep(1000)
  rmSync(fixture, { recursive: true, force: true })
  process.chdir(appRoot)
}
