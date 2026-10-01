// The current executor and SQLite store require a persistent Node host.
// Authentication can run on Vercel independently of the browser executor.
export const serverlessHost = () => process.env.VERCEL === "1"
export const sealedSessions = () => serverlessHost() || process.env.HAC_SESSION_MODE === "sealed"
