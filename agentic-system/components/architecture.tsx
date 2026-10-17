"use client"

import { useState } from "react"
import { RiUser3Line, RiSparkling2Line, RiShieldCheckLine, RiGitBranchLine, RiComputerLine, RiDatabase2Line, RiGlobalLine, RiCpuLine, RiKey2Line } from "@remixicon/react"

const nodes = [
  { id: "principal", title: "Human Principal", sub: "Free Identity", x: 40, y: 3, icon: RiUser3Line, detail: "The human signs in through FreeID and explicitly grants a mandate. In this first version the Principal acts in a personal capacity." },
  { id: "root", title: "Root agent", sub: "Eve · durable context", x: 40, y: 23, icon: RiSparkling2Line, detail: "Owns the goal and durable conversation. Plans and delegates bounded work to the browser worker. It cannot grant itself authority." },
  { id: "governance", title: "Governance", sub: "Mandates + policy", x: 8, y: 46, icon: RiShieldCheckLine, detail: "Stores human mandates and signed delegation records. A deterministic policy function checks origin, expiry, revocation, action limits and approval requirements." },
  { id: "control", title: "Control plane", sub: "Authorize · dispatch", x: 40, y: 46, icon: RiGitBranchLine, detail: "Non-agentic execution gate. Validates the authority chain, reserves an action slot atomically, requests approval when needed, and dispatches only permitted browser operations." },
  { id: "audit", title: "Audit trail", sub: "Decisions + effects", x: 72, y: 46, icon: RiDatabase2Line, detail: "Persists human grants, delegations, policy decisions, approvals, revocations and browser outcomes. Records are associated with their Principal and mandate." },
  { id: "browser", title: "Browser worker", sub: "Isolated browser context", x: 40, y: 72, icon: RiComputerLine, detail: "A declared Eve subagent receives a bounded task. A fresh Chromium context provides screenshots and browser actions. It has no shell or arbitrary code tool. Idle contexts close after ten minutes." },
  { id: "model", title: "Vision model", sub: "Screenshot grounding", x: 8, y: 72, icon: RiCpuLine, detail: "The worker model interprets screenshots and proposes clicks, typing and navigation. Every proposed action passes through the control plane." },
  { id: "target", title: "Clearance", sub: "External demo website", x: 72, y: 72, icon: RiGlobalLine, detail: "The separate Clearance demo is the browser-use target. The runtime operates its existing interface; the site is not embedded into the HAC application." },
]
export function Architecture() {
  const [selected, setSelected] = useState("control")
  const current = nodes.find(n => n.id === selected)!
  return <div className="architecture-view">
    <div className="section-title"><div><span className="eyebrow">The execution model</span><h2>Every action has a human origin.</h2><p>The browser-use branch of your HAC architecture.</p></div><span className="small-tag">Interactive map</span></div>
    <div className="diagram-scroll"><div className="diagram">
      <svg viewBox="0 0 900 520" aria-hidden="true" className="diagram-lines">
        <defs>{[["ops", "sy-s-ink"], ["policy", "sy-s-gold"], ["audit", "diagram-audit"]].map(([id, line]) => <marker key={id} id={id} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto-start-reverse"><path d="M1,1 L7,4 L1,7" className={line} strokeWidth="1.4" /></marker>)}</defs>
        <path d="M30 100H875 M30 350H875" className="diagram-boundary" strokeDasharray="3 7" />
        <g className="sy-s-ink" strokeWidth="1.6" markerEnd="url(#ops)"><path d="M450 75V119"/><path d="M450 178V240"/><path d="M450 295V375"/><path d="M540 152H610V405H541"/><path d="M540 407H646"/><path d="M250 407H359"/></g>
        <path d="M250 272H359" className="sy-s-gold" strokeWidth="1.6" markerEnd="url(#policy)" />
        <path d="M540 272H646 M540 430H600V297H646" className="diagram-audit" strokeWidth="1.6" markerEnd="url(#audit)" />
        <text x="623" y="201">scoped delegation</text><text x="40" y="94">Principal</text><text x="40" y="344">Effectors</text>
      </svg>
      {nodes.map(n => <button key={n.id} style={{ left: `${n.x}%`, top: `${n.y}%` }} onClick={() => setSelected(n.id)} className={`diagram-node ${selected === n.id ? "selected" : ""} ${["model", "target"].includes(n.id) ? "external" : ""}`}><n.icon size={18}/><strong>{n.title}</strong><small>{n.sub}</small></button>)}
    </div></div>
    <div className="diagram-legend"><span><i className="line ops"/>Operational flow</span><span><i className="line policy"/>Policy decision</span><span><i className="line audit"/>Audit event</span><span><i className="line boundary"/>Trust boundary</span></div>
    <div className="inspector sy-card"><current.icon size={22}/><div><h3>{current.title}</h3><p>{current.detail}</p></div></div>
    <div className="architecture-note"><RiKey2Line size={18}/><p>Credentials stay with the control plane. General API effectors and full desktop computer use are future adapters; this implementation executes the browser branch.</p></div>
  </div>
}
