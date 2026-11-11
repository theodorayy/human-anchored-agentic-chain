"use client"

import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from "react"
import Link from "next/link"
import Image from "next/image"
import { useTheme } from "next-themes"
import { RiAddLine, RiArrowRightUpLine, RiChat3Line, RiCloseLine, RiComputerLine, RiFileList3Line, RiGitBranchLine, RiLoader4Line, RiLogoutBoxRLine, RiMoonLine, RiQrCodeLine, RiSunLine, RiUser3Line, RiDownload2Line, RiDeleteBinLine, RiDraggable, RiSubtractLine, RiExpandUpDownLine } from "@remixicon/react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { AgentChat, type Continuation, type TaskPermissions } from "./agent-chat"
import { Architecture } from "./architecture"
import type { AuditEvent, Mandate, Run, Snapshot } from "@/lib/hac/types"
import { Check } from "./check"
import { PauseIcon } from "./pause-icon"

const empty: Snapshot = { principal: null, mandates: [], runs: [], audit: [], sessions: [], demoAvailable: false, oidcAvailable: false, eveAvailable: false, targetUrl: "https://clearance-review-demo.vercel.app" }
const label = (r: Run) => r.summary || (r.action.kind === "navigate" ? "Open website" : r.action.kind === "click" ? `Click at ${r.action.x}, ${r.action.y}` : r.action.kind === "type" ? "Enter text" : r.action.kind === "press" ? `Press ${r.action.key}` : r.action.kind === "inspect" ? "Read page" : r.action.kind === "close" ? "Close browser" : "Scroll page")
const active = (m: Mandate) => !m.revokedAt && Date.parse(m.expiresAt) > Date.now() && m.usedActions < m.maxActions
// The assistant speaks in the first person: "Approve before I click …".
const beforeI = (r: Run) => { const text = label(r); return `Approve before I ${text.charAt(0).toLowerCase()}${text.slice(1)}` }
const time = (at: string) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
const auditLabel = (a: AuditEvent) => ({ "mandate.created": "You granted permissions", "mandate.revoked": "You stopped access", "session.started": "Sisyphus started a task", "task.delegated": "Sisyphus proposed a browser action", "policy.allow": "Action permitted", "policy.require_approval": "Your approval is required", "policy.deny": "Action blocked", "browser.completed": "Browser action completed", "execution.failed": "Browser action failed", "approval.granted": "You approved an action", "approval.rejected": "You declined an action" }[a.event] || a.event.replaceAll(".", " · "))

export function ControlRoom({ sessionId }: { sessionId?: string }) {
  const [boundSessionId, setBoundSessionId] = useState(sessionId)
  const [chatOpen, setChatOpen] = useState(true)
  // The dock renders only after the snapshot loads, so reading storage here cannot cause a hydration mismatch.
  const [chatWidth, setChatWidth] = useState(() => typeof window === "undefined" ? 440 : Math.max(360, Number(window.localStorage.getItem("sisyphus.chat-width")) || 440))
  const resizeChat = useCallback((width: number) => {
    const next = Math.round(Math.min(Math.max(width, 360), Math.max(360, window.innerWidth - 32)))
    setChatWidth(next); window.localStorage.setItem("sisyphus.chat-width", String(next))
  }, [])
  function startChatResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault()
    const startX = event.clientX, startWidth = chatWidth
    const onMove = (move: PointerEvent) => resizeChat(startWidth + startX - move.clientX)
    const onUp = () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); document.body.classList.remove("resizing-chat") }
    document.body.classList.add("resizing-chat")
    window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp)
  }
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
  async function deleteTasks(ids: string[], question: string) {
    if (!window.confirm(question)) return
    for (const id of ids) await mutate(`tasks/${encodeURIComponent(id)}/delete`)
    if (boundSessionId && ids.includes(boundSessionId)) window.location.href = "/workspace"
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
    setNotice(approve ? "Action approved and executed. Sisyphus will inspect the result and continue." : "Action declined. Sisyphus will report what remains unfinished.")
    setContinuation({ id: crypto.randomUUID(), message: approve
      ? `I approved action ${run.id} in this workspace. Its recorded status is ${result.status}. Continue the original task with the same browser worker (${run.workerId}). Inspect the current page first; do not repeat the approved action.`
      : `I declined action ${run.id} in this workspace. Do not retry it or work around that decision. Explain what remains unfinished.` })
  }
  const mandate = snapshot.mandates.find(m => m.id === mandateId)
  const task = snapshot.sessions.find(s => s.id === boundSessionId)
  // Older saved sessions lack the root ID, so retain their Sisyphus actions within their mandate.
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
      <Link href="/workspace" className="brand"><span className="brand-ball" aria-hidden="true"/><span><span className="brand-name">Sisyphus</span><span className="brand-caption">Browser workspace</span></span></Link>
      <a href="/workspace" className="new-session" aria-label="New task"><RiAddLine size={17}/> New task <span>↗</span></a>
      <nav>{[{ text: "Task", icon: RiChat3Line }, { text: "Audit log", icon: RiFileList3Line }, { text: "Architecture", icon: RiGitBranchLine }].map(n => <button key={n.text} aria-label={n.text} title={n.text} className={tab === n.text ? "nav-item active" : "nav-item"} onClick={() => setTab(n.text)}><n.icon size={18}/>{n.text}{n.text === "Task" && pending.length > 0 && <span className="nav-count">{pending.length}</span>}</button>)}</nav>
      <div className="recent-sessions"><div className="recent-sessions-head"><span className="nav-label">Recent tasks</span>{snapshot.sessions.length > 0 && <button className="session-clear" disabled={!!busy} onClick={() => deleteTasks(snapshot.sessions.map(s => s.id), "Delete all tasks? Sisyphus loses browser access for each one. The audit log is kept.")}>Delete all</button>}</div>{snapshot.sessions.length === 0 ? <p>Your tasks will appear here.</p> : snapshot.sessions.slice(-6).reverse().map((s, i) => <div key={s.id} className="session-row"><a href={`/s/${s.id}`} title={s.title || `Task ${snapshot.sessions.length - i}`} className={s.id === boundSessionId ? "session-link chosen" : "session-link"}><RiChat3Line size={14}/><span>{s.title || `Task ${snapshot.sessions.length - i}`}</span></a><button className="session-delete" aria-label={`Delete ${s.title || "task"}`} title="Delete task" disabled={!!busy} onClick={() => deleteTasks([s.id], "Delete this task? Sisyphus loses browser access for it. The audit log is kept.")}><RiDeleteBinLine size={14}/></button></div>)}</div>
      <div className="sidebar-bottom"><div className="profile"><span className="avatar"><RiUser3Line size={18}/></span><div><strong>{snapshot.principal?.name || "Your workspace"}</strong><small>Signed in with FreeID</small></div><Button variant="ghost" size="icon-sm" aria-label="Sign out" onClick={async () => { await mutate("auth/logout"); window.location.assign("/") }}><RiLogoutBoxRLine/></Button></div></div>
    </aside>
    <div className="workspace">
      <header className="topbar"><div className="breadcrumb">Workspace <span>/</span><strong>{tab === "Task" ? task?.title || (boundSessionId ? "Current task" : "New task") : tab}</strong></div><div className="topbar-actions"><Button variant="ghost" size="sm" onClick={() => setTab("Audit log")}><RiFileList3Line/>Audit log</Button><Button variant="ghost" size="icon-sm" aria-label="Toggle colour theme" onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>{resolvedTheme === "dark" ? <RiSunLine/> : <RiMoonLine/>}</Button></div></header>
      <main className="main-content">
        {(error || notice) && <div className={`global-message ${error ? "error" : ""}`} role={error ? "alert" : "status"}>{error || notice}<button aria-label="Dismiss notice" onClick={() => { setError(""); setNotice("") }}><RiCloseLine size={15}/></button></div>}
        {!loaded ? <div className="loading"><RiLoader4Line className="animate-spin"/>Loading your workspace…</div> : <div className="workspace-body">
          <section className="primary-panel">
            {tab === "Task" && <><div className="task-view">
              {!runtimeReady && <div className="global-message error" role="alert">The AI or browser connection is unavailable.</div>}<div className="task-view-head"><span className="eyebrow">Task details</span><h1>{task?.title || (boundSessionId ? "Current task" : "Start with a task")}</h1></div>
            {!boundSessionId && <div className="task-explainer task-explainer-main"><p>Describe what you want in the chat. You’ll choose Sisyphus’s permissions before anything runs.</p><ol><li>Sisyphus opens the website in its browser.</li><li>You follow the work here.</li><li>If an action needs approval, it appears here with a button.</li></ol><p>The Audit log records each action and decision.</p></div>}
              {boundSessionId && <div className="task-stack">
            {pending.length > 0 && <section id="task-approvals" className="approvals" aria-label="Your approval is required">{pending.map(r => <div key={r.id} className="approval-card approval-bar sy-approve"><span className="sy-approve__icon"><PauseIcon/></span><div className="approval-bar-text"><span className="sy-approve__title">Your turn</span><span className="sy-approve__sub">{beforeI(r)}</span><p>{r.action.kind === "click" ? "The gold marker on the browser below shows where." : r.action.kind === "press" ? `Press ${r.action.key}.` : r.reason} It has not run yet.</p>{r.action.kind === "type" && <pre>{r.action.text}</pre>}</div>
                <div className="sy-approve__actions"><button className="sy-btn sy-btn--pill sy-btn--gold" disabled={!!busy} onClick={() => void review(r, true)}>Approve & continue</button><button className="sy-btn sy-btn--pill sy-btn--outline" disabled={!!busy} onClick={() => void review(r, false)}>Decline</button></div></div>)}</section>}
            <section className="browser-section"><div className="context-section-heading"><span className="eyebrow">Sisyphus’s browser</span><RiComputerLine size={16}/></div><div className="browser-card sy-window"><div className="sy-window__bar"><i/><i/><i/><small>{pageHost}</small></div>{onIdentityProvider && <div className="identity-scan-prompt" role="status"><span className="sy-check"><RiQrCodeLine aria-hidden="true"/></span><span><strong>Scan this code with your FreeID app</strong><small>Waiting for you</small></span></div>}{latest?.screenshotId ? <button className="browser-screenshot" onClick={() => setImageId(latest.screenshotId!)} aria-label="Enlarge browser screenshot"><Image unoptimized width={1280} height={800} src={`/api/screenshots/${latest.screenshotId}`} alt="Latest screenshot from this task’s browser"/>{pending.map(r => r.action.kind === "click" ? <span key={r.id} className="click-marker" style={{ left: `${r.action.x / 1280 * 100}%`, top: `${r.action.y / 800 * 100}%` }}/> : null)}</button> : <div className="browser-empty"><RiComputerLine size={28}/><p>Waiting for Sisyphus to open the website</p></div>}</div>
              <div className="browser-footer"><span>{latest ? `Captured ${time(latest.createdAt)}` : "Screenshots appear as Sisyphus works"}</span>{latest && <button onClick={() => setImageId(latest.screenshotId!)}>Enlarge<RiArrowRightUpLine size={13}/></button>}</div>
            </section>
            <div className="task-columns">
            <section className="context-section"><span className="eyebrow">Recent actions</span>
              {runs.length === 0 ? <p className="muted-line">Nothing yet.</p> : runs.slice(0, 4).map(r => <div className="action-receipt" key={r.id}><div className="recent-action"><span>{label(r)}</span><small className={`state-badge ${r.status}`}>{r.status === "approval" ? "Needs approval" : r.status}</small></div>{["failed", "denied"].includes(r.status) && <p>{r.reason}</p>}</div>)}
              <button className="text-link" onClick={() => setTab("Audit log")}>View audit log <RiArrowRightUpLine size={13}/></button>
            </section>
            {mandate && <section className="context-section"><span className="eyebrow">Permissions for this task</span><div className="mandate-details"><div className="mandate-state"><span className={`state-badge ${active(mandate) ? "completed" : "denied"}`}>{active(mandate) ? "Access active" : "Access ended"}</span><small>{mandate.maxActions - mandate.usedActions} actions left</small></div><dl><div><dt>{(mandate.origins?.length ?? 1) > 1 ? "Websites" : "Website"}</dt><dd>{(mandate.origins ?? [mandate.origin]).map(o => new URL(o).hostname).join(", ")}</dd></div><div><dt>Interactions</dt><dd>{mandate.requireApproval ? "Ask you first" : "Allowed within this task"}</dd></div><div><dt>Access expires</dt><dd>{new Date(mandate.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</dd></div></dl>{active(mandate) && <button className="revoke-button" disabled={!!busy} onClick={async () => { if (await mutate(`mandates/${mandate.id}/revoke`)) setNotice("Access stopped. Sisyphus can no longer use the browser for this task.") }}>Stop browser access</button>}</div></section>}
            </div>
              </div>}
            </div></>}
            {tab === "Architecture" && <Architecture/>}
            {tab === "Audit log" && <div className="activity-view"><div className="section-title"><div><span className="eyebrow">Audit log</span><h2>What happened, and why.</h2><p>Permissions, proposed actions, your approvals, and browser results.</p></div><a href="/api/audit/export" download className="export-link"><RiDownload2Line size={15}/>Export all</a></div>
              {boundSessionId && <div className="audit-filter"><button className={!allAudit ? "selected" : ""} onClick={() => setAuditScope("task")}>This task</button><button className={allAudit ? "selected" : ""} onClick={() => setAuditScope("all")}>All tasks</button></div>}
              <div className="audit-list">{audit.length === 0 ? <div className="empty-state"><RiFileList3Line size={30}/><h3>No actions recorded yet.</h3><p>Start a task to see Sisyphus’s work and the decisions behind it.</p></div> : audit.map(a => <article key={a.id}>{a.event.includes("deny") || a.event.includes("failed") || a.event.includes("rejected") || a.event.includes("revoked") ? <span className="audit-symbol denied" aria-hidden="true"/> : <span className="audit-symbol"><Check/></span>}<div><strong>{auditLabel(a)}</strong><p>{a.detail}</p>{a.typedText !== undefined && <div className="audit-typed-text"><span>Text entered</span><pre>{a.typedText}</pre></div>}<details className="audit-detail"><summary>Technical details</summary><small>{a.actionDetail && <>{a.actionDetail}<br/></>}{a.event} · {a.actor}<br/>Event: {a.id}{a.runId && <><br/>Action: {a.runId}</>}</small></details></div><time dateTime={a.at} title={new Date(a.at).toLocaleString()}>{time(a.at)}</time></article>)}</div>
            </div>}
          </section>
        </div>}
      </main>
    </div>
    {loaded && <aside className={chatOpen ? "chat-dock" : "chat-dock minimised"} style={{ width: chatOpen ? `min(${chatWidth}px, calc(100vw - 2rem))` : undefined }} aria-label="Conversation with Sisyphus">
      {chatOpen && <button type="button" className="chat-dock-grip" aria-label="Resize conversation" title="Drag to resize conversation" onPointerDown={startChatResize} onKeyDown={e => { if (e.key === "ArrowLeft") resizeChat(chatWidth + 24); if (e.key === "ArrowRight") resizeChat(chatWidth - 24) }}><RiDraggable size={12} aria-hidden="true"/></button>}
      <header className="chat-dock-head"><span className="brand-ball" aria-hidden="true"/><strong>Sisyphus</strong>{pending.length > 0 && <span className="nav-count">{pending.length}</span>}<Button variant="ghost" size="icon-sm" aria-label={chatOpen ? "Minimise conversation" : "Open conversation"} onClick={() => setChatOpen(open => !open)}>{chatOpen ? <RiSubtractLine/> : <RiExpandUpDownLine/>}</Button></header>
      <div className="chat-dock-body" hidden={!chatOpen}><AgentChat snapshot={snapshot} mandateId={mandateId} sessionId={sessionId} onSession={setBoundSessionId} onCreatePermissions={createPermissions} continuation={continuation}/></div>
    </aside>}
    <Dialog open={!!imageId} onOpenChange={open => { if (!open) setImageId(null) }}><DialogContent className="screenshot-dialog"><DialogHeader><DialogTitle>Sisyphus’s browser</DialogTitle><DialogDescription>A captured screenshot from this task, not an interactive browser.</DialogDescription></DialogHeader>{imageId && <Image unoptimized width={1280} height={800} src={`/api/screenshots/${imageId}`} alt="Full browser screenshot"/>}</DialogContent></Dialog>
  </div>
}
