export type Principal = { id: string; name: string; provider: "demo" | "oidc" }
export type Scope = { action: "browser:use"; origin: string; maxActions: number; requireApproval: boolean }
export type Grant = {
  id: string; parentId: string | null; mandateId: string; principalId: string;
  agent: "root" | "browser-worker"; scope: Scope; expiresAt: string; signature: string;
}
export type Mandate = {
  id: string; principalId: string; title: string; accountableParty: string;
  maxActions: number; usedActions: number; requireApproval: boolean;
  origin: string; createdAt: string; expiresAt: string; revokedAt: string | null; grant: Grant;
}
export type BrowserAction =
  | { kind: "navigate"; url: string }
  | { kind: "inspect" }
  | { kind: "click"; x: number; y: number }
  | { kind: "type"; text: string }
  | { kind: "press"; key: "Enter" | "Tab" | "Escape" | "Backspace" | "ArrowDown" | "ArrowUp" }
  | { kind: "scroll"; deltaY: number }
  | { kind: "close" }
export type Run = {
  id: string; principalId: string; mandateId: string; workerId: string;
  action: BrowserAction; mode: "manual" | "eve";
  rootSessionId?: string;
  summary?: string;
  status: "queued" | "executing" | "approval" | "completed" | "denied" | "failed";
  reason: string; createdAt: string; approvedAt: string | null; delegation: Grant;
  screenshotId?: string; pageUrl?: string; pageTitle?: string; observation?: string;
}
export type AuditEvent = {
  id: string; at: string; principalId: string; runId?: string; mandateId?: string;
  actor: string; event: string; detail: string; actionDetail?: string; typedText?: string;
}
export type State = {
  version: 1; signingKey: string; mandates: Mandate[]; runs: Run[]; audit: AuditEvent[];
  sessions: { hash: string; expiresAt: number; principal: Principal }[];
  oauth: { state: string; nonce: string; verifier: string; expiresAt: number }[];
  eveSessions: { id: string; principalId: string; mandateId: string; title?: string }[];
}
export type Snapshot = {
  observedAt?: number;
  principal: Principal | null; mandates: Mandate[]; runs: Run[]; audit: AuditEvent[];
  sessions: { id: string; mandateId: string; title?: string }[];
  demoAvailable: boolean; oidcAvailable: boolean; eveAvailable: boolean; targetUrl: string;
  runtimeAvailable?: boolean;
}
