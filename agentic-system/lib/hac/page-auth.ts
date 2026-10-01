import "server-only"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { principalFor } from "./auth"

export async function pagePrincipal() {
  return principalFor(new Request("http://hac.internal", { headers: await headers() }))
}
export async function requirePagePrincipal() {
  const principal = await pagePrincipal()
  if (!principal) redirect("/")
  return principal
}
