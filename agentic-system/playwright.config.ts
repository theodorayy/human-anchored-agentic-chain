import { defineConfig } from "@playwright/test"
export default defineConfig({
  testDir: "./tests/e2e", fullyParallel: false, workers: 1, timeout: 60_000,
  use: { baseURL: process.env.HAC_TEST_URL || "http://localhost:3003", viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure" },
  reporter: "list",
})
