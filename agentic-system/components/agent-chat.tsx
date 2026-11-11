"use client"
import { useEffect, useMemo, useRef, useState } from "react"
import { useEveAgent } from "eve/react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { RiArrowUpLine, RiStopFill, RiArrowRightUpLine, RiLoader4Line, RiShieldCheckLine, RiGlobalLine, RiHome4Line } from "@remixicon/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import type { Mandate, Snapshot } from "@/lib/hac/types"
import { HillMark } from "./hill-mark"
import { PauseIcon } from "./pause-icon"

export type TaskPermissions = { title: string; maxActions: number; durationHours: number; requireApproval: boolean; origins: string[] }
export type Continuation = { id: string; message: string }
type Props = {
  snapshot: Snapshot; mandateId: string; sessionId?: string;
  onSession: (id: string) => void;
  onCreatePermissions: (input: TaskPermissions) => Promise<Mandate | null>;
  continuation?: Continuation;
  onStalled?: () => void;
}
// Survives remounts, so reconnecting the chat never resends an approval continuation.
const consumedContinuations = new Set<string>()
// A turn can finish on the server while the Vercel → Fly proxy drops the last stream events.
// With no new events for this long, the parent remounts the chat on the same session and
// eve's resume replays to the turn boundary. The draft survives the remount.
const STALL_MS = 20_000
let draft = ""

export function AgentChat({ snapshot, mandateId, sessionId, onSession, onCreatePermissions, continuation, onStalled }: Props) {
  const [message, setMessageState] = useState(draft)
  const setMessage = (text: string) => { draft = text; setMessageState(text) }
  const [confirmTask, setConfirmTask] = useState("")
  // Websites preselected by a starter; null means every configured website.
  const [starterSites, setStarterSites] = useState<string[] | null>(null)
  const [starting, setStarting] = useState(false)
  const [sendError, setSendError] = useState("")
  const credentials = useRef({ mandateId, title: "" })
  const end = useRef<HTMLDivElement>(null)
  const agent = useEveAgent({
    ...(sessionId ? { initialSession: { sessionId, streamIndex: 0 }, resume: true } : {}),
    // Resolve immediately before each request, including the first task submission.
    headers: () => ({ "x-hac-mandate": credentials.current.mandateId, "x-hac-task": encodeURIComponent(credentials.current.title) }),
  })
  useEffect(() => { if (mandateId) credentials.current.mandateId = mandateId }, [mandateId])
  const working = agent.status === "submitted" || agent.status === "streaming" || agent.status === "resuming"
  // True while the chat is only following a background browser task, not waiting on a reply to
  // the human. The human can still send then; the message steers the session.
  const [following, setFollowing] = useState(false)
  const canSteer = following && agent.status === "streaming"
  const busy = working && !canSteer
  const currentSession = agent.session?.sessionId || sessionId
  const currentRuns = snapshot.runs.filter(r => r.rootSessionId === currentSession || (!r.rootSessionId && r.mode === "eve" && r.mandateId === mandateId))
  const awaitingApproval = !!currentSession && currentRuns.some(r => r.status === "approval")
  const connected = !!snapshot.principal && snapshot.eveAvailable && snapshot.runtimeAvailable !== false
  const mandate = snapshot.mandates.find(m => m.id === mandateId)
  const authorityEnded = !!currentSession && !!mandate && (!!mandate.revokedAt || Date.parse(mandate.expiresAt) <= (snapshot.observedAt || 0) || mandate.usedActions >= mandate.maxActions)
  useEffect(() => {
    if (agent.session?.sessionId) {
      onSession(agent.session.sessionId)
      if (!sessionId) window.history.replaceState(null, "", `/s/${agent.session.sessionId}`)
    }
  }, [agent.session?.sessionId, sessionId, onSession])
  // The browser worker runs as an eve background task. Its result arrives in a turn the server
  // starts by itself, after this client's turn has ended, so keep following the session until
  // every background task the agent started has reported back.
  const backgroundPending = useMemo(() => {
    const started = new Set<string>(), finished = new Set<string>()
    for (const event of agent.events) {
      const data = ("data" in event ? event.data : {}) as { backgroundTask?: { status?: string; taskId?: string }; message?: unknown }
      if (event.type === "subagent.completed" && data.backgroundTask?.status === "working" && data.backgroundTask.taskId) started.add(data.backgroundTask.taskId)
      if (event.type === "message.received" && typeof data.message === "string") {
        const id = /^Background task (\S+)/.exec(data.message)?.[1]
        if (id) finished.add(id)
      }
    }
    return [...started].some(id => !finished.has(id))
  }, [agent.events])
  useEffect(() => {
    if (!backgroundPending || agent.status !== "ready" || !currentSession) return
    const timer = window.setTimeout(() => {
      setFollowing(true)
      void agent.resume().catch(() => {}).finally(() => setFollowing(false))
    }, 1500)
    return () => window.clearTimeout(timer)
  }, [backgroundPending, agent.status, currentSession, agent])
  useEffect(() => {
    if (!working || backgroundPending || !currentSession || !onStalled) return
    const timer = window.setTimeout(onStalled, STALL_MS)
    return () => window.clearTimeout(timer)
  }, [working, backgroundPending, agent.events.length, currentSession, onStalled])
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }) }, [agent.data.messages, agent.status])
  useEffect(() => {
    if (!continuation || consumedContinuations.has(continuation.id) || busy || !currentSession || !connected) return
    consumedContinuations.add(continuation.id)
    void agent.send(continuation.message, canSteer ? { turnPolicy: "steer" } : undefined).catch(() => { setMessage(continuation.message) })
  }, [continuation, busy, canSteer, currentSession, connected, agent])

  async function send() {
    if (!message.trim() || !connected || busy || starting) return
    if (!currentSession) { setConfirmTask(message.trim()); return }
    const text = message; setMessage(""); setSendError("")
    await agent.send(text, canSteer ? { turnPolicy: "steer" } : undefined).catch(() => { setMessage(text) })
  }
  async function startTask(input: TaskPermissions) {
    setStarting(true); setSendError("")
    try {
      const permission = await onCreatePermissions(input)
      if (!permission) { setSendError("Could not save permissions. Please try again."); return }
      credentials.current = { mandateId: permission.id, title: confirmTask.slice(0, 160) }
      const task = confirmTask
      setConfirmTask(""); setMessage("")
      await agent.send(task).catch(() => { setMessage(task) })
    } finally { setStarting(false) }
  }
  const sites = snapshot.targets?.length ? snapshot.targets : [{ name: "NYC Fibre", url: snapshot.targetUrl, origin: new URL(snapshot.targetUrl).origin }]
  const status = authorityEnded ? "Permissions ended" : awaitingApproval ? "Your approval is needed" : agent.error ? "Sisyphus encountered a problem" : working ? "Sisyphus is working" : "Sisyphus is waiting for you"
  const detail = authorityEnded ? "Start a new task to grant fresh permissions." : awaitingApproval ? "Review the proposed action in Task details. Approve & continue resumes Sisyphus automatically." : working ? "Browser actions and their results appear in Task details and Audit log." : "Read Sisyphus’s response below, or send a follow-up."
  return <div className="chat-view">
    {currentSession && <div className={`task-status ${awaitingApproval ? "needs-approval" : ""}`} role="status">
      {awaitingApproval ? <span className="sy-approve__icon"><PauseIcon/></span> : working ? <RiLoader4Line size={18} className="animate-spin"/> : <RiShieldCheckLine size={18}/>}
      <div><strong>{status}</strong><p>{detail}</p></div>
      {awaitingApproval && <a href="#task-approvals" className="sy-btn sy-btn--pill sy-btn--gold">Review action <RiArrowRightUpLine size={14}/></a>}
    </div>}
    <div className="chat-scroll">
      {agent.data.messages.length === 0 ? <div className="chat-welcome">
        <HillMark variant="mini" className="chat-hill"/>
        <span className="eyebrow">Sisyphus, your browser agent</span>
        <h1>What should <b>Sisyphus</b> do?</h1>
        <p>Tell Sisyphus what’s happening in your life.<br/>You’ll confirm its permissions before it starts.</p>
        <div className="task-steps"><span>1. Describe the task</span><span>2. Set permissions</span><span>3. Follow the work</span></div>
        <div className="suggestions">
          {[{ title: "I’m moving to New York", text: "I’m moving to New York next month as an international student. What admin do I need to sort out?", icon: RiGlobalLine, sites: null }, { title: "Set up home internet", text: "Set up home internet with NYC Fibre at 2 West Loop Road, Apt 14C, New York 10044. 1 Gig plan, email maria.santos@example.com, phone (212) 555-0142, earliest installation date. I don’t have an SSN.", icon: RiHome4Line, sites: ["NYC Fibre"] }].map(s => <button key={s.title} className="sy-card" onClick={() => { setMessage(s.text); setStarterSites(s.sites) }}><s.icon size={20}/><span>{s.title}</span><RiArrowRightUpLine size={16}/></button>)}
        </div>
        <div className="welcome-target">{sites.length > 1 ? "Websites" : "Website"} {sites.map(t => <a key={t.origin} href={t.url} target="_blank" rel="noreferrer">{t.name} <RiArrowRightUpLine size={12}/></a>)}</div>
      </div> : <div className="messages">{agent.data.messages.map(m => <article key={m.id} className={`message ${m.role}`}>
        <div className="message-author">{m.role === "assistant" ? <><i aria-hidden="true"/> Sisyphus</> : "You"}</div>
        {m.parts.map((part, index) => part.type === "text" ? (m.role === "assistant" ? <div key={index} className="message-text markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{part.text}</ReactMarkdown></div> : <div key={index} className="message-text">{part.text}</div>) : part.type === "dynamic-tool" ? <details key={index} className="tool-event"><summary>{part.toolName === "browser_worker" ? "Browser task" : part.toolName === "inspect_mandate" ? "Permission check" : part.toolName.replaceAll("_", " ")}<small>{part.state === "output-available" ? "Response received" : part.state === "output-error" ? "Failed" : "In progress"}</small></summary><p>Individual browser actions and policy decisions are recorded in the Audit log.</p></details> : null)}
      </article>)}<div ref={end}/></div>}
    </div>
    <div className="composer-wrap">
      {(agent.error || sendError) && <div className="inline-error" role="alert">{agent.error?.message || sendError}</div>}
      {!connected && <p className="composer-notice">{snapshot.runtimeAvailable === false ? "The browser service is offline." : "The AI connection is unavailable. Try again once it is connected."}</p>}
      <form className="composer sy-card" onSubmit={e => { e.preventDefault(); void send() }}>
        <textarea aria-label="Message Sisyphus" placeholder={currentSession ? "Ask Sisyphus a question or give a follow-up…" : "Describe the task you want Sisyphus to complete…"} value={message} onChange={e => setMessage(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }} rows={2}/>
        <div className="composer-bottom"><span><i aria-hidden="true"/> Sisyphus</span>{busy ? <Button type="button" aria-label="Stop Sisyphus" size="sm" className="sy-btn sy-btn--primary" onClick={() => void agent.cancel()}><RiStopFill/>Stop</Button> : <Button type="submit" aria-label={currentSession ? "Send message" : "Review permissions"} size="sm" className="sy-btn sy-btn--primary" disabled={!connected || !message.trim() || starting}>{currentSession ? <><RiArrowUpLine/>Send</> : <>Review permissions<RiArrowRightUpLine/></>}</Button>}</div>
      </form>
      <p className="composer-footnote">{currentSession ? "Sisyphus can act only within the permissions you granted." : "Nothing runs until you confirm the task and permissions."}</p>
    </div>
    <Dialog open={!!confirmTask} onOpenChange={open => { if (!open && !starting) setConfirmTask("") }}><DialogContent><DialogHeader><DialogTitle>Confirm task & permissions</DialogTitle><DialogDescription>These permissions apply to this task. You can stop access at any time.</DialogDescription></DialogHeader>
      <form className="mandate-form" onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); const origins = sites.length > 1 ? data.getAll("site").map(String) : [sites[0].origin]; if (!origins.length) { setSendError("Choose at least one website."); return } void startTask({ title: confirmTask.slice(0, 100), maxActions: Number(data.get("maxActions")), durationHours: Number(data.get("durationHours")), requireApproval: data.get("approval") === "ask", origins }) }}>
        <div className="task-confirmation"><Label>Task</Label><p>{confirmTask}</p></div>
        {sites.length > 1 ? <fieldset className="permission-options site-options"><legend>Websites</legend>
          {sites.map(t => <label key={t.origin}><input type="checkbox" name="site" value={t.origin} defaultChecked={!starterSites || starterSites.includes(t.name)}/><span><strong>{t.name}</strong><small>{new URL(t.url).hostname}</small></span></label>)}
        </fieldset> : <div className="scope-preview"><RiGlobalLine size={16}/><span>{new URL(sites[0].url).hostname} only</span></div>}
        <fieldset className="permission-options"><legend>How much may Sisyphus do?</legend>
          <label><input type="radio" name="approval" value="ask" defaultChecked/><span><strong>Ask before each click</strong><small>Sisyphus can open and read pages, and type the details you give it. You approve each click.</small></span></label>
          <label><input type="radio" name="approval" value="allow"/><span><strong>Let Sisyphus complete the task</strong><small>Allow clicks, typing, and submissions on {sites.length > 1 ? "these websites" : "this website"} without asking each time.</small></span></label>
        </fieldset>
        <div className="form-pair"><div><Label htmlFor="task-action-limit">Maximum browser actions</Label><Input id="task-action-limit" name="maxActions" type="number" min={1} max={200} defaultValue={100} required/></div><div><Label htmlFor="task-duration">Access lasts (hours)</Label><Input id="task-duration" name="durationHours" type="number" min={1} max={24} defaultValue={1} required/></div></div>
        {sendError && <p className="inline-error" role="alert">{sendError}</p>}
        <Button type="submit" className="sy-btn sy-btn--primary sy-btn--block" disabled={starting}>{starting ? <RiLoader4Line className="animate-spin"/> : <RiShieldCheckLine/>}{starting ? "Starting…" : "Confirm & start task"}</Button>
      </form>
    </DialogContent></Dialog>
  </div>
}
