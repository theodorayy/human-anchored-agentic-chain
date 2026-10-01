import { ControlRoom } from "@/components/control-room"
import { notFound } from "next/navigation"
import { requirePagePrincipal } from "@/lib/hac/page-auth"
import { transaction } from "@/lib/hac/store"
import { serverlessHost } from "@/lib/hac/deployment"
export default async function SessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const principal = await requirePagePrincipal()
  if (serverlessHost()) notFound()
  const { sessionId } = await params
  if (!transaction(state => state.eveSessions.some(s => s.id === sessionId && s.principalId === principal.id))) notFound()
  return <ControlRoom sessionId={sessionId}/>
}
