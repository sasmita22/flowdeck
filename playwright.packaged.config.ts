import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  testMatch: "packaged.spec.ts",
  workers: 1,
});
