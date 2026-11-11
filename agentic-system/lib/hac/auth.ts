import { createHash, randomBytes, randomUUID } from "node:crypto"
import { transaction } from "./store"
import { HttpError } from "./control-plane"
import type { Principal } from "./types"
import { serverlessHost, sealedSessions } from "./deployment"
import { openCookie, sealCookie } from "./sealed-cookie"

export const sessionCookie = "hac_session"
export const demoAvailable = () => !serverlessHost() && process.env.HAC_DEMO === "true"
export const oidcAvailable = () => Boolean(process.env.OIDC_ISSUER && process.env.OIDC_CLIENT_ID && (!sealedSessions() || process.env.HAC_SESSION_SECRET))
export const eveAvailable = () => !serverlessHost() && Boolean(process.env.OPENAI_API_KEY)
export const appUrl = () => process.env.APP_URL || "http://localhost:3003"
const hash = (value: string) => createHash("sha256").update(value).digest("hex")

export function readCookie(request: Request, name: string) {
  const cookie = request.headers.get("cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith(`${name}=`))
  return cookie?.slice(name.length + 1)
}
export function principalFor(request: Request): Principal | null {
  const token = readCookie(request, sessionCookie)
  if (!token) return null
  if (sealedSessions()) {
    const principal = openCookie<Principal>("session", token)
    return principal?.provider === "oidc" && typeof principal.id === "string" && typeof principal.name === "string" ? principal : null
  }
  return transaction(state => state.sessions.find(s => s.hash === hash(token) && s.expiresAt > Date.now())?.principal || null)
}
export function requirePrincipal(request: Request) {
  const principal = principalFor(request)
  if (!principal) throw new HttpError(401, "Sign in to continue.")
  return principal
}
export function requireSameOrigin(request: Request) {
  if (request.headers.get("origin") !== new URL(appUrl()).origin) throw new HttpError(403, "A same-origin request is required.")
}
export function cookieHeader(name: string, value: string, maxAge = 28_800) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${appUrl().startsWith("https:") ? "; Secure" : ""}`
}
export function createSession(principal: Principal) {
  if (sealedSessions()) {
    if (principal.provider !== "oidc") throw new Error("Hosted sessions require verified OIDC identity.")
    return cookieHeader(sessionCookie, sealCookie("session", principal, 3600), 3600)
  }
  const token = randomBytes(32).toString("hex")
  transaction(state => {
    state.sessions = state.sessions.filter(s => s.expiresAt > Date.now())
    state.sessions.push({ hash: hash(token), expiresAt: Date.now() + 28_800_000, principal })
  })
  return cookieHeader(sessionCookie, token)
}
export function demoSession() {
  if (!demoAvailable()) throw new HttpError(404, "Local demo sign-in is disabled.")
  return createSession({ id: `demo:${randomUUID()}`, name: "Demo principal", provider: "demo" })
}
export function logout(request: Request) {
  const token = readCookie(request, sessionCookie)
  if (token && !sealedSessions()) transaction(state => { state.sessions = state.sessions.filter(s => s.hash !== hash(token)) })
  return cookieHeader(sessionCookie, "", 0)
}
