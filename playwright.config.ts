import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  testIgnore:
    process.env["FLOWDECK_LIVE"] === "1"
      ? ["packaged.spec.ts"]
      : ["packaged.spec.ts", "**/*.live.spec.ts"],
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  outputDir: "test-results",
});
