import { redirect } from "next/navigation"
import { LoginGate } from "@/components/login-gate"
import { pagePrincipal } from "@/lib/hac/page-auth"
import { oidcAvailable, demoAvailable } from "@/lib/hac/auth"

export default async function Page({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await pagePrincipal()) redirect("/workspace")
  return <LoginGate available={oidcAvailable()} demo={demoAvailable()} signInError={(await searchParams).error === "signin"}/>
}
