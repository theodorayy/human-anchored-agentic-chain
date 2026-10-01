import type { NextConfig } from "next"
import { withEve } from "eve/next"

const nextConfig: NextConfig = { devIndicators: false, serverExternalPackages: ["playwright"] }

// Keep the public Vercel origin while the persistent host serves one coherent
// workspace, including its API, Eve streams and matching Next.js assets.
if (process.env.VERCEL === "1" && process.env.HAC_RUNTIME_ORIGIN) {
  const origin = new URL(process.env.HAC_RUNTIME_ORIGIN)
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password)
    throw new Error("HAC_RUNTIME_ORIGIN must be an HTTPS origin.")
  nextConfig.rewrites = async () => ({ beforeFiles: [{ source: "/:path*", destination: `${origin.origin}/:path*` }] })
}

if (process.env.VERCEL !== "1" && process.env.NODE_ENV === "production") {
  const port = Number(process.env.EVE_NEXT_PRODUCTION_PORT || "4274")
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid Eve port.")
  nextConfig.rewrites = async () => ({ beforeFiles: [{ source: "/eve/v1/:path+", destination: `http://127.0.0.1:${port}/eve/v1/:path+` }] })
}
export default process.env.VERCEL === "1" || process.env.NODE_ENV === "production" ? nextConfig : withEve(nextConfig)
