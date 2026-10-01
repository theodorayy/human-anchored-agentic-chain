import { ControlRoom } from "@/components/control-room"
import { requirePagePrincipal } from "@/lib/hac/page-auth"

export default async function WorkspacePage() {
  await requirePagePrincipal()
  return <ControlRoom/>
}
