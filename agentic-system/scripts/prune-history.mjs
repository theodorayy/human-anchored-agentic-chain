import { existsSync, readdirSync, readFileSync, rmSync, statfsSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"

// Eve keeps every run's events, steps and stream chunks on the data volume, roughly 60 MB per
// browser task, and never deletes them. When the volume passes `high`, delete the history of the
// oldest tasks until it is under `low`, always keeping the newest `keep` tasks. A pruned task
// leaves Recent tasks the way "Delete task" does: its mandate is revoked and its audit is kept.

export function diskUsage(path) {
  const s = statfsSync(path)
  return 1 - s.bavail / s.blocks
}

function runCreatedAt(eveDir, id) {
  try { return Date.parse(JSON.parse(readFileSync(join(eveDir, "runs", `${id}.json`), "utf8")).createdAt) } catch { return NaN }
}

// Deletes every run created before `cutoff` (ms). Returns the number of runs removed.
export function deleteRunsBefore(eveDir, cutoff) {
  const runsDir = join(eveDir, "runs")
  if (!existsSync(runsDir)) return 0
  const old = new Set(readdirSync(runsDir).map(f => f.replace(/\.json$/, "")).filter(id => runCreatedAt(eveDir, id) < cutoff))
  for (const dir of ["events", "steps", "waits"]) {
    if (!existsSync(join(eveDir, dir))) continue
    for (const f of readdirSync(join(eveDir, dir))) if (old.has(f.split("-")[0])) rmSync(join(eveDir, dir, f), { force: true })
  }
  for (const id of old) {
    rmSync(join(runsDir, `${id}.json`), { force: true })
    rmSync(join(eveDir, "streams", "runs", `${id}.json`), { force: true })
  }
  const chunks = join(eveDir, "streams", "chunks")
  if (existsSync(chunks)) for (const d of readdirSync(chunks)) {
    if (old.has(`wrun_${d.replace(/^strm_/, "").replace(/_user$/, "")}`)) rmSync(join(chunks, d), { recursive: true, force: true })
  }
  return old.size
}

// Drops task bindings whose eve history is gone, revoking their mandates. Returns tasks removed.
export function forgetPrunedTasks(hacDir, eveDir) {
  const db = new DatabaseSync(join(hacDir, "control-plane.sqlite"))
  try {
    db.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE")
    const row = db.prepare("SELECT value FROM state WHERE id=1").get()
    if (!row) { db.exec("ROLLBACK"); return 0 }
    const state = JSON.parse(row.value)
    const now = new Date().toISOString()
    const gone = state.eveSessions.filter(s => !existsSync(join(eveDir, "runs", `${s.id}.json`)))
    for (const s of gone) {
      const m = state.mandates.find(x => x.id === s.mandateId)
      if (m && !m.revokedAt) {
        m.revokedAt = now
        for (const r of state.runs.filter(r => r.mandateId === m.id && ["approval", "queued"].includes(r.status))) { r.status = "denied"; r.reason = "The task was deleted." }
      }
      state.audit.push({ id: randomUUID(), at: now, principalId: s.principalId, mandateId: s.mandateId, actor: "Control plane", event: "task.deleted", detail: "Task history removed to free storage. Its browser access ended; its audit record is kept." })
    }
    state.eveSessions = state.eveSessions.filter(s => !gone.includes(s))
    db.prepare("UPDATE state SET value=? WHERE id=1").run(JSON.stringify(state))
    db.exec("COMMIT")
    return gone.length
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK")
    throw error
  } finally { db.close() }
}

function newestTaskStarts(hacDir, eveDir) {
  const file = join(hacDir, "control-plane.sqlite")
  if (!existsSync(file)) return []
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const row = db.prepare("SELECT value FROM state WHERE id=1").get()
    const sessions = row ? JSON.parse(row.value).eveSessions : []
    return sessions.map(s => runCreatedAt(eveDir, s.id)).filter(Number.isFinite).sort((a, b) => b - a)
  } finally { db.close() }
}

export function pruneHistory({ hacDir, eveDir, high = 0.7, low = 0.5, keep = 3, usage = () => diskUsage(eveDir) }) {
  if (usage() < high) return { pruned: 0, forgotten: 0 }
  const starts = newestTaskStarts(hacDir, eveDir)
  // With no listed tasks, everything older than an hour is orphaned history.
  if (starts.length === 0) {
    const pruned = deleteRunsBefore(eveDir, Date.now() - 3_600_000)
    return { pruned, forgotten: 0 }
  }
  let pruned = 0
  // First drop orphaned history older than every listed task, then keep fewer and fewer of the
  // newest tasks until usage falls under `low`, never fewer than `keep`. A minute's margin keeps
  // the runs a task starts just before its own session run.
  for (let kept = starts.length; kept >= Math.min(keep, starts.length); kept--) {
    pruned += deleteRunsBefore(eveDir, starts[kept - 1] - 60_000)
    if (usage() < low) break
  }
  return { pruned, forgotten: pruned ? forgetPrunedTasks(hacDir, eveDir) : 0 }
}
