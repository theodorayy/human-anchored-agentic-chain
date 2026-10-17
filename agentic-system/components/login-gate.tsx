"use client"

import { useState } from "react"
import Link from "next/link"
import { RiArrowRightLine, RiLockLine } from "@remixicon/react"
import { Button } from "@/components/ui/button"
import { Check } from "@/components/check"
import { HillMark } from "@/components/hill-mark"

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
          Sisyphus
        </Link>
        <div className="login-intro">
          <p className="eyebrow">Your life-admin assistant</p>
          <h1 className="login-statement">
            Let Sisyphus <b>save you some time.</b>
          </h1>
          <p className="login-lede">
            It fills the forms with you and pauses for your approval.
          </p>
        </div>
        <HillMark className="login-hill" />
      </section>
      <section className="login-entry">
        <span className="login-private">
          <RiLockLine size={14} /> Private workspace
        </span>
        <div className="login-card sy-card">
          <h2>Welcome to your workspace.</h2>
          <p>
            Sign in to give your agent a goal. Stay in control of every step.
          </p>
          <Button
            className="sy-btn sy-btn--primary sy-btn--block"
            disabled={!available || busy}
            onClick={() => {
              setBusy(true)
              window.location.assign("/api/auth/login")
            }}
          >
            {busy
              ? "Connecting to FreeID…"
              : "Sign in with FreeID"}
            <RiArrowRightLine aria-hidden="true" />
          </Button>
          {!available && (
            <p className="login-availability" role="status">
              Sign-in is not configured for this workspace yet.
            </p>
          )}
          {demo && (
            <Button
              variant="outline"
              className="sy-btn sy-btn--outline sy-btn--block"
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
            {[
              "Your identity, verified by FreeID",
              "Authority granted explicitly by you",
              "Agent actions checked before execution",
            ].map((text) => (
              <span key={text}>
                <Check /> {text}
              </span>
            ))}
          </div>
          <p className="login-note">
            Signing in establishes who you are. Your agent acts only after you
            issue a mandate.
          </p>
        </div>
        <footer className="login-footer">
          <span>Powered by FreeID</span>
          <span>Eve runtime</span>
        </footer>
      </section>
    </main>
  )
}
