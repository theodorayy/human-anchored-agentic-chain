"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import Image from "next/image"
import { useTheme } from "next-themes"
import { RiAddLine, RiArrowRightUpLine, RiChat3Line, RiCloseLine, RiComputerLine, RiFileList3Line, RiGitBranchLine, RiLoader4Line, RiLogoutBoxRLine, RiMoonLine, RiShieldCheckLine, RiSparkling2Line, RiSunLine, RiUser3Line, RiDownload2Line } from "@remixicon/react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { AgentChat, type Continuation, type TaskPermissions } from "./agent-chat"
import { Architecture } from "./architecture"
import type { AuditEvent, Mandate, Run, Snapshot } from "@/lib/hac/types"

const empty: Snapshot = { principal: null, mandates: [], runs: [], audit: [], sessions: [], demoAvailable: false, oidcAvailable: false, eveAvailable: false, targetUrl: "https://clearance-review-demo.vercel.app" }
const label = (r: Run) => r.summary || (r.action.kind === "navigate" ? "Open website" : r.action.kind === "click" ? `Click at ${r.action.x}, ${r.action.y}` : r.action.kind === "type" ? "Enter text" : r.action.kind === "press" ? `Press ${r.action.key}` : r.action.kind === "inspect" ? "Read page" : r.action.kind === "close" ? "Close browser" : "Scroll page")
const active = (m: Mandate) => !m.revokedAt && Date.parse(m.expiresAt) > Date.now() && m.usedActions < m.maxActions
const time = (at: string) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
const auditLabel = (a: AuditEvent) => ({ "mandate.created": "You granted permissions", "mandate.revoked": "You stopped access", "session.started": "Eve started a task", "task.delegated": "Eve proposed a browser action", "policy.allow": "Action permitted", "policy.require_approval": "Your approval is required", "policy.deny": "Action blocked", "browser.completed": "Browser action completed", "execution.failed": "Browser action failed", "approval.granted": "You approved an action", "approval.rejected": "You declined an action" }[a.event] || a.event.replaceAll(".", " · "))

export function ControlRoom({ sessionId }: { sessionId?: string }) {
  const [boundSessionId, setBoundSessionId] = useState(sessionId)
  const [snapshot, setSnapshot] = useState<Snapshot>(empty)
  const [loaded, setLoaded] = useState(false)
  const [tab, setTab] = useState("Task")
  const [mandateId, setMandateId] = useState("")
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [imageId, setImageId] = useState<string | null>(null)
  const [continuation, setContinuation] = useState<Continuation>()
  const [auditScope, setAuditScope] = useState("task")
  const { resolvedTheme, setTheme } = useTheme()
  const refresh = useCallback(async () => {
    const response = await fetch("/api/state", { cache: "no-store" })
    if (response.status === 401) { window.location.replace("/"); return }
    if (!response.ok) throw new Error("Could not load task activity.")
    const next: Snapshot = await response.json()
    setSnapshot(next); setLoaded(true)
    setMandateId(previous => next.sessions.find(s => s.id === boundSessionId)?.mandateId || previous)
  }, [boundSessionId])
  useEffect(() => {
    let mounted = true
    const update = () => refresh().catch(e => { if (mounted) setError(e.message) })
    void update()
    const interval = setInterval(() => void update(), 2500)
    return () => { mounted = false; clearInterval(interval) }
  }, [refresh])
  async function mutate(path: string, body?: unknown) {
    setBusy(path); setError(""); setNotice("")
    try {
      const response = await fetch(`/api/${path}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, ...(body ? { body: JSON.stringify(body) } : {}) })
      const result = response.status === 204 ? null : await response.json()
      if (!response.ok) throw new Error(result?.error || "The action could not be completed.")
      await refresh()
      return result
    } catch (e) { setError(e instanceof Error ? e.message : "Request failed."); return null }
    finally { setBusy("") }
  }
  async function createPermissions(input: TaskPermissions): Promise<Mandate | null> {
    const result = await mutate("mandates", input)
    if (result) setMandateId(result.id)
    return result
  }
  async function review(run: Run, approve: boolean) {
    const result: Run | null = await mutate(`runs/${encodeURIComponent(run.id)}/${approve ? "approve" : "reject"}`)
    if (!result) return
    if (approve && result.status !== "completed") { setError(result.reason); return }
    setTab("Task")
    setNotice(approve ? "Action approved and executed. Eve will inspect the result and continue." : "Action declined. Eve will report what remains unfinished.")
    setContinuation({ id: crypto.randomUUID(), message: approve
      ? `I approved action ${run.id} in this workspace. Its recorded status is ${result.status}. Continue the original task with the same browser worker (${run.workerId}). Inspect the current page first; do not repeat the approved action.`
      : `I declined action ${run.id} in this workspace. Do not retry it or work around that decision. Explain what remains unfinished.` })
  }
  const mandate = snapshot.mandates.find(m => m.id === mandateId)
  const task = snapshot.sessions.find(s => s.id === boundSessionId)
  // Older saved sessions lack the root ID, so retain their Eve actions within their mandate.
  const runs = boundSessionId ? snapshot.runs.filter(r => r.rootSessionId === boundSessionId || (!r.rootSessionId && r.mode === "eve" && r.mandateId === mandateId)) : []
  const pending = runs.filter(r => r.status === "approval")
  const latest = runs.find(r => r.screenshotId)
  const pageOrigin = (() => { try { return new URL(latest?.pageUrl || snapshot.targetUrl).origin } catch { return "" } })()
  const pageHost = (() => { try { return new URL(latest?.pageUrl || snapshot.targetUrl).host } catch { return "Website" } })()
  const onIdentityProvider = !!latest?.pageUrl && (snapshot.identityProviderOrigins || []).includes(pageOrigin)
  const runIds = new Set(runs.map(r => r.id))
  const allAudit = auditScope === "all" || !boundSessionId
  const audit = allAudit ? snapshot.audit : snapshot.audit.filter(a => a.runId ? runIds.has(a.runId) : a.mandateId === mandateId || (a.event === "session.started" && a.detail.includes(boundSessionId!)))
  const runtimeReady = snapshot.runtimeAvailable !== false && snapshot.eveAvailable
  return <div className="control-room">
    <aside className="sidebar">
      <Link href="/workspace" className="brand"><span className="brand-symbol"><RiSparkling2Line size={23}/></span><span>Eve<span className="brand-caption">Browser workspace</span></span></Link>
      <a href="/workspace" className="new-session" aria-label="New task"><RiAddLine size={17}/> New task <span>↗</span></a>
      <nav>{[{ text: "Task", icon: RiChat3Line }, { text: "Audit log", icon: RiFileList3Line }, { text: "Architecture", icon: RiGitBranchLine }].map(n => <button key={n.text} aria-label={n.text} title={n.text} className={tab === n.text ? "nav-item active" : "nav-item"} onClick={() => setTab(n.text)}><n.icon size={18}/>{n.text}{n.text === "Task" && pending.length > 0 && <span className="nav-count">{pending.length}</span>}</button>)}</nav>
      <div className="recent-sessions"><span className="nav-label">RECENT TASKS</span>{snapshot.sessions.length === 0 ? <p>Your tasks will appear here.</p> : snapshot.sessions.slice(-6).reverse().map((s, i) => <a key={s.id} href={`/s/${s.id}`} title={s.title || `Task ${snapshot.sessions.length - i}`} className={s.id === boundSessionId ? "session-link chosen" : "session-link"}><RiChat3Line size={14}/><span>{s.title || `Task ${snapshot.sessions.length - i}`}</span></a>)}</div>
      <div className="sidebar-bottom"><div className="profile"><span className="avatar"><RiUser3Line size={18}/></span><div><strong>{snapshot.principal?.name || "Your workspace"}</strong><small>Signed in with Free Identity</small></div><Button variant="ghost" size="icon-sm" aria-label="Sign out" onClick={async () => { await mutate("auth/logout"); window.location.assign("/") }}><RiLogoutBoxRLine/></Button></div></div>
    </aside>
    <div className="workspace">
      <header className="topbar"><div className="breadcrumb">Workspace <span>/</span><strong>{tab === "Task" ? task?.title || (boundSessionId ? "Current task" : "New task") : tab}</strong></div><div className="topbar-actions"><Button variant="ghost" size="sm" onClick={() => setTab("Audit log")}><RiFileList3Line/>Audit log</Button><Button variant="ghost" size="icon-sm" aria-label="Toggle color theme" onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>{resolvedTheme === "dark" ? <RiSunLine/> : <RiMoonLine/>}</Button></div></header>
      <main className="main-content">
        {(error || notice) && <div className={`global-message ${error ? "error" : ""}`} role={error ? "alert" : "status"}>{error || notice}<button aria-label="Dismiss notice" onClick={() => { setError(""); setNotice("") }}><RiCloseLine size={15}/></button></div>}
        {!loaded ? <div className="loading"><RiLoader4Line className="animate-spin"/>Loading your workspace…</div> : <div className="workspace-body">
          <section className="primary-panel">
            <div className="task-pane" hidden={tab !== "Task"}><AgentChat snapshot={snapshot} mandateId={mandateId} sessionId={sessionId} onSession={setBoundSessionId} onCreatePermissions={createPermissions} continuation={continuation}/></div>
            {tab === "Architecture" && <Architecture/>}
            {tab === "Audit log" && <div className="activity-view"><div className="section-title"><div><span className="eyebrow">AUDIT LOG</span><h2>What happened, and why.</h2><p>Permissions, proposed actions, your approvals, and browser results.</p></div><a href="/api/audit/export" download className="export-link"><RiDownload2Line size={15}/>Export all</a></div>
              {boundSessionId && <div className="audit-filter"><button className={!allAudit ? "selected" : ""} onClick={() => setAuditScope("task")}>This task</button><button className={allAudit ? "selected" : ""} onClick={() => setAuditScope("all")}>All tasks</button></div>}
              <div className="audit-list">{audit.length === 0 ? <div className="empty-state"><RiFileList3Line size={30}/><h3>No actions recorded yet.</h3><p>Start a task to see Eve’s work and the decisions behind it.</p></div> : audit.map(a => <article key={a.id}><div className={`audit-symbol ${a.event.includes("deny") || a.event.includes("failed") ? "denied" : ""}`}><RiGitBranchLine size={16}/></div><div><strong>{auditLabel(a)}</strong><p>{a.detail}</p>{a.typedText !== undefined && <div className="audit-typed-text"><span>Text entered</span><pre>{a.typedText}</pre></div>}<details className="audit-detail"><summary>Technical details</summary><small>{a.actionDetail && <>{a.actionDetail}<br/></>}{a.event} · {a.actor}<br/>Event: {a.id}{a.runId && <><br/>Action: {a.runId}</>}</small></details></div><time dateTime={a.at} title={new Date(a.at).toLocaleString()}>{time(a.at)}</time></article>)}</div>
            </div>}
          </section>
          <aside className="context-panel"><div className="context-title"><RiShieldCheckLine size={17}/><h2>Task details</h2></div>
            {!boundSessionId && <div className="task-explainer"><strong>Start with a task</strong><p>Describe what you want in the chat. You’ll choose Eve’s permissions before anything runs.</p><ol><li>Eve opens the demo in its browser.</li><li>You follow the work here.</li><li>If an action needs approval, it appears here with a button.</li></ol><p>The Audit log records each action and decision.</p></div>}
            {pending.length > 0 && <section id="task-approvals" className="context-section approvals"><span className="eyebrow">YOUR APPROVAL IS REQUIRED</span>{pending.map(r => {
              const before = runs.find(previous => previous.workerId === r.workerId && previous.screenshotId && previous.createdAt < r.createdAt)
              return <div key={r.id} className="approval-card"><strong>{label(r)}</strong><p>Eve has proposed this action. It has not run yet.</p>
                {before?.screenshotId && <button className="approval-frame" aria-label="Inspect proposed action screenshot" onClick={() => setImageId(before.screenshotId!)}><Image unoptimized width={1280} height={800} src={`/api/screenshots/${before.screenshotId}`} alt="Browser before the proposed action"/>{r.action.kind === "click" && <span className="click-marker" style={{ left: `${r.action.x / 1280 * 100}%`, top: `${r.action.y / 800 * 100}%` }}/>}</button>}
                <p>{r.action.kind === "click" ? `Click at (${r.action.x}, ${r.action.y}) in the browser shown above.` : r.action.kind === "press" ? `Press ${r.action.key}.` : r.reason}</p>{r.action.kind === "type" && <pre>{r.action.text}</pre>}
                <div><Button size="sm" disabled={!!busy} onClick={() => void review(r, true)}>Approve & continue</Button><Button variant="outline" size="sm" disabled={!!busy} onClick={() => void review(r, false)}>Decline</Button></div></div>
            })}</section>}
            {boundSessionId && <section className="context-section browser-section"><div className="context-section-heading"><span className="eyebrow">EVE’S BROWSER</span><RiComputerLine size={16}/></div><div className="browser-card"><div className="browser-chrome"><span/><span/><span/><small>{pageHost}</small></div>{onIdentityProvider && <p className="identity-scan-prompt"><strong>Scan this code with your FreeID app</strong></p>}{latest?.screenshotId ? <button className="browser-screenshot" onClick={() => setImageId(latest.screenshotId!)} aria-label="Enlarge browser screenshot"><Image unoptimized width={1280} height={800} src={`/api/screenshots/${latest.screenshotId}`} alt="Latest screenshot from this task’s browser"/></button> : <div className="browser-empty"><RiComputerLine size={28}/><p>Waiting for Eve to open the website</p></div>}</div>
              <div className="browser-footer"><span>{latest ? `Captured ${time(latest.createdAt)}` : "Screenshots appear as Eve works"}</span>{latest && <button onClick={() => setImageId(latest.screenshotId!)}>Enlarge<RiArrowRightUpLine size={13}/></button>}</div>
              {runs.slice(0, 3).map(r => <div className="action-receipt" key={r.id}><div className="recent-action"><span>{label(r)}</span><small className={`state-badge ${r.status}`}>{r.status === "approval" ? "Needs approval" : r.status}</small></div>{["failed", "denied"].includes(r.status) && <p>{r.reason}</p>}</div>)}
              <button className="text-link" onClick={() => setTab("Audit log")}>View audit log <RiArrowRightUpLine size={13}/></button>
            </section>}
            {mandate && boundSessionId && <section className="context-section"><span className="eyebrow">PERMISSIONS FOR THIS TASK</span><div className="mandate-details"><div className="mandate-state"><span className={`state-badge ${active(mandate) ? "completed" : "denied"}`}>{active(mandate) ? "Access active" : "Access ended"}</span><small>{mandate.maxActions - mandate.usedActions} actions left</small></div><dl><div><dt>Website</dt><dd>{new URL(mandate.origin).hostname}</dd></div><div><dt>Interactions</dt><dd>{mandate.requireApproval ? "Ask you first" : "Allowed within this task"}</dd></div><div><dt>Access expires</dt><dd>{new Date(mandate.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</dd></div></dl>{active(mandate) && <button className="revoke-button" disabled={!!busy} onClick={async () => { if (await mutate(`mandates/${mandate.id}/revoke`)) setNotice("Access stopped. Eve can no longer use the browser for this task.") }}>Stop browser access</button>}</div></section>}
            <div className="context-bottom"><RiShieldCheckLine size={14}/><p>{runtimeReady ? "Signed in with Free Identity. Eve’s browser is limited to the permissions you grant." : "The AI or browser connection is unavailable."}</p></div>
          </aside>
        </div>}
      </main>
    </div>
    <Dialog open={!!imageId} onOpenChange={open => { if (!open) setImageId(null) }}><DialogContent className="screenshot-dialog"><DialogHeader><DialogTitle>Eve’s browser</DialogTitle><DialogDescription>A captured screenshot from this task, not an interactive browser.</DialogDescription></DialogHeader>{imageId && <Image unoptimized width={1280} height={800} src={`/api/screenshots/${imageId}`} alt="Full browser screenshot"/>}</DialogContent></Dialog>
  </div>
}
