import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  testIgnore: "packaged.spec.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: "list",
  outputDir: "test-results",
});
