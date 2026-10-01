"use client"

import { useState } from "react"
import Link from "next/link"
import {
  RiArrowRightLine,
  RiCheckLine,
  RiGitBranchLine,
  RiKey2Line,
  RiLockLine,
  RiShieldCheckLine,
  RiSparkling2Line,
  RiUser3Line,
} from "@remixicon/react"
import { Button } from "@/components/ui/button"

export function LoginGate({
  available,
  demo,
  signInError,
}: {
  available: boolean
  demo: boolean
  signInError: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(
    signInError ? "Sign-in could not be completed. Please try again." : ""
  )
  return (
    <main className="login-page">
      <section className="login-story">
        <Link href="/" className="login-brand">
          <span className="brand-symbol">
            <RiGitBranchLine size={24} />
          </span>
          <span>
            HAC <small>Agentic system</small>
          </span>
        </Link>
        <div className="login-intro">
          <div
            className="login-chain"
            aria-label="Human identity, scoped authority, agent execution"
          >
            <div>
              <span>
                <RiUser3Line size={21} />
              </span>
              <strong>You</strong>
              <small>Verified identity</small>
            </div>
            <i />
            <div>
              <span>
                <RiShieldCheckLine size={21} />
              </span>
              <strong>Your mandate</strong>
              <small>Scoped authority</small>
            </div>
            <i />
            <div>
              <span>
                <RiSparkling2Line size={21} />
              </span>
              <strong>Your agent</strong>
              <small>Bounded execution</small>
            </div>
          </div>
        </div>
        <p className="login-story-footer">
          <RiGitBranchLine size={15} /> Human-anchored agentic chain{" "}
          <span>01</span>
        </p>
      </section>
      <section className="login-entry">
        <span className="login-private">
          <RiLockLine size={13} /> PRIVATE WORKSPACE
        </span>
        <div className="login-card">
          <span className="login-key">
            <RiKey2Line size={25} />
          </span>
          <h2>Welcome to your workspace.</h2>
          <p>
            Sign in to give your agent a goal.
            <br />
            Stay in control of every step.
          </p>
          <Button
            className="login-button"
            disabled={!available || busy}
            onClick={() => {
              setBusy(true)
              window.location.assign("/api/auth/login")
            }}
          >
            <RiKey2Line />
            {busy
              ? "Connecting to Free Identity…"
              : "Sign in with Free Identity"}
            <RiArrowRightLine />
          </Button>
          {!available && (
            <p className="login-availability" role="status">
              Sign-in is not configured for this workspace yet.
            </p>
          )}
          {demo && (
            <Button
              variant="outline"
              className="w-full"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setError("")
                try {
                  const response = await fetch("/api/auth/demo", {
                    method: "POST",
                  })
                  if (!response.ok) throw new Error("Test sign-in failed.")
                  window.location.assign("/workspace")
                } catch {
                  setError("Test sign-in failed. Please try again.")
                  setBusy(false)
                }
              }}
            >
              Use local test identity
            </Button>
          )}
          {error && (
            <p role="alert" className="inline-error">
              {error}
            </p>
          )}
          <div className="login-assurance">
            <span>
              <RiCheckLine size={16} /> Your identity, verified by FreeID
            </span>
            <span>
              <RiCheckLine size={16} /> Authority granted explicitly by you
            </span>
            <span>
              <RiCheckLine size={16} /> Agent actions checked before execution
            </span>
          </div>
          <div className="login-note">
            <RiShieldCheckLine size={18} />
            <p>
              Signing in establishes who you are.
              <br />
              Your agent acts only after you issue a mandate.
            </p>
          </div>
        </div>
        <footer className="login-footer">
          <span>Powered by Free Identity</span>
          <span>Eve runtime</span>
        </footer>
      </section>
    </main>
  )
}
