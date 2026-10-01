import { DatabaseSync } from "node:sqlite"
import { mkdirSync } from "node:fs"
import { resolve, join } from "node:path"
import { randomBytes } from "node:crypto"
import type { State } from "./types"

// One SQLite transaction contains the decision, budget debit, execution receipt and
// audit records. BEGIN IMMEDIATE serializes competing executors across processes.
export function transaction<T>(work: (state: State) => T): T {
  const directory = resolve(/* turbopackIgnore: true */ process.env.HAC_DATA_DIR || ".hac")
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(join(directory, "control-plane.sqlite"))
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;")
    db.exec("CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)")
    db.exec("BEGIN IMMEDIATE")
    const row = db.prepare("SELECT value FROM state WHERE id=1").get() as { value: string } | undefined
    const state: State = row ? JSON.parse(row.value) : {
      version: 1, signingKey: randomBytes(32).toString("hex"),
      mandates: [], runs: [], audit: [], sessions: [], oauth: [], eveSessions: [],
    }
    const result = work(state)
    db.prepare("INSERT INTO state(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(JSON.stringify(state))
    db.exec("COMMIT")
    return result
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK")
    throw error
  } finally { db.close() }
}
