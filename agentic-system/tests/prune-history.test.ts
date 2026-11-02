import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { pruneHistory } from "../scripts/prune-history.mjs"

const minute = 60_000
function fixture(taskCount: number, orphans: number) {
  const root = mkdtempSync(join(tmpdir(), "hac-prune-"))
  const eveDir = join(root, "eve"), hacDir = join(root, "hac")
  for (const d of ["runs", "events", "steps", "waits", "streams/runs", "streams/chunks"]) mkdirSync(join(eveDir, d), { recursive: true })
  mkdirSync(hacDir)
  const t0 = Date.parse("2026-11-01T00:00:00Z")
  const run = (id: string, at: number) => {
    writeFileSync(join(eveDir, "runs", `${id}.json`), JSON.stringify({ runId: id, createdAt: new Date(at).toISOString() }))
    writeFileSync(join(eveDir, "events", `${id}-evnt_1.json`), "{}")
    writeFileSync(join(eveDir, "steps", `${id}-step_1.json`), "{}")
    mkdirSync(join(eveDir, "streams", "chunks", `strm_${id.slice(5)}_user`))
    mkdirSync(join(eveDir, "streams", "chunks", `strm_${id.slice(5)}_user_ZXZlLnRhc2s`))
    mkdirSync(join(eveDir, "streams", "chunks", `strm_${id.slice(5)}_system_abort`))
  }
  for (let i = 0; i < orphans; i++) run(`wrun_ORPHAN${i}`, t0 + i * minute)
  const sessions = []
  for (let i = 0; i < taskCount; i++) {
    const at = t0 + (100 + i * 10) * minute
    run(`wrun_TASK${i}`, at)
    run(`wrun_WORKER${i}`, at + 5_000) // a worker the task started
    sessions.push({ id: `wrun_TASK${i}`, principalId: "p", mandateId: `m${i}` })
  }
  const db = new DatabaseSync(join(hacDir, "control-plane.sqlite"))
  db.exec("CREATE TABLE state (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
  db.prepare("INSERT INTO state VALUES (1, ?)").run(JSON.stringify({
    eveSessions: sessions, mandates: sessions.map(s => ({ id: s.mandateId, revokedAt: null })), runs: [], audit: [],
  }))
  db.close()
  const runCount = () => readdirSync(join(eveDir, "runs")).length
  const readState = () => { const d = new DatabaseSync(join(hacDir, "control-plane.sqlite")); try { return JSON.parse((d.prepare("SELECT value FROM state").get() as { value: string }).value) } finally { d.close() } }
  return { eveDir, hacDir, runCount, readState }
}

test("prunes orphans, then the oldest tasks, until usage is under the low-water mark", () => {
  const f = fixture(6, 4)
  // Pretend each run takes 5% of the disk: 16 runs = 80%. Orphans (4) go first, then whole tasks
  // (2 runs each) oldest first, stopping at the first point under 50%: 8 runs, tasks 2 to 5.
  const result = pruneHistory({ hacDir: f.hacDir, eveDir: f.eveDir, usage: () => f.runCount() * 0.05 })
  assert.ok(f.runCount() * 0.05 < 0.5)
  for (const id of ["TASK2", "WORKER2", "TASK3", "WORKER3", "TASK4", "WORKER4", "TASK5", "WORKER5"]) assert.ok(existsSync(join(f.eveDir, "runs", `wrun_${id}.json`)), id)
  for (const id of ["ORPHAN0", "ORPHAN3", "TASK0", "WORKER0", "TASK1", "WORKER1"]) {
    assert.ok(!existsSync(join(f.eveDir, "runs", `wrun_${id}.json`)), id)
    assert.ok(!existsSync(join(f.eveDir, "events", `wrun_${id}-evnt_1.json`)), id)
    for (const channel of ["user", "user_ZXZlLnRhc2s", "system_abort"]) assert.ok(!existsSync(join(f.eveDir, "streams", "chunks", `strm_${id}_${channel}`)), `${id} ${channel}`)
  }
  const state = f.readState()
  assert.deepEqual(state.eveSessions.map((s: { id: string }) => s.id), ["wrun_TASK2", "wrun_TASK3", "wrun_TASK4", "wrun_TASK5"])
  assert.ok(state.mandates.find((m: { id: string }) => m.id === "m0").revokedAt)
  assert.equal(state.mandates.find((m: { id: string }) => m.id === "m5").revokedAt, null)
  assert.equal(result.forgotten, 2)
})

test("never prunes below the newest three tasks, even if still full", () => {
  const f = fixture(3, 2)
  pruneHistory({ hacDir: f.hacDir, eveDir: f.eveDir, usage: () => 0.95 })
  assert.equal(f.runCount(), 6)
  assert.equal(f.readState().eveSessions.length, 3)
})

test("does nothing below the high-water mark", () => {
  const f = fixture(5, 3)
  assert.deepEqual(pruneHistory({ hacDir: f.hacDir, eveDir: f.eveDir, usage: () => 0.69 }), { pruned: 0, forgotten: 0 })
  assert.equal(f.runCount(), 13)
})
