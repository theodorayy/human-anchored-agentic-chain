import { spawn } from "node:child_process"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const freeid = resolve(appRoot, "../free-identity")
const backendPort = process.env.FREEID_PORT || "3006"
const frontendPort = process.env.FREEID_FRONTEND_PORT || "3004"
const backend = `http://localhost:${backendPort}`
const frontend = `http://localhost:${frontendPort}`
const common = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` }
const children = [
  spawn(process.execPath, ["--env-file=../../envs/local/auth-server.env", "../../node_modules/@nestjs/cli/bin/nest.js", "start", "--watch"], {
    cwd: resolve(freeid, "apps/auth-server"), stdio: "inherit", env: { ...common,
      PORT: backendPort, FRONTEND_URL: frontend, OIDC_ISSUER_URL: backend,
      WEBAUTHN_RP_ID: "localhost", WEBAUTHN_ORIGIN: frontend, IS_LOCAL: "true",
      DATABASE_URL: process.env.FREEID_DATABASE_URL || "postgres://freeid:password123@localhost:5432/freeid_db",
      REDIS_URL: process.env.FREEID_REDIS_URL || "redis://localhost:6379",
    },
  }),
  spawn("pnpm", ["--filter", "auth-frontend", "run", "dev", "--port", frontendPort], {
    cwd: freeid, stdio: "inherit", env: { ...common, NEXT_PUBLIC_API_URL: backend },
  }),
]
console.log(`FreeID backend ${backend}; login UI ${frontend}. HAC runs separately on :3003.`)
let shuttingDown = false
function stop() { if (shuttingDown) return; shuttingDown = true; for (const child of children) child.kill("SIGTERM") }
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop)
for (const child of children) {
  child.on("error", error => { console.error(error.message); process.exitCode = 1; stop() })
  child.on("exit", code => { if (code && !shuttingDown) { process.exitCode = code; stop() } })
}
