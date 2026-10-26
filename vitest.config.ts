import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: process.env.FLOWDECK_LIVE === "1" ? [] : ["**/*.live.test.ts"],
  },
});
