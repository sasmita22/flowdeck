import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/app/renderer",
  build: {
    outDir: fileURLToPath(new URL("./.vite/renderer/main_window", import.meta.url)),
    emptyOutDir: true,
  },
  plugins: [react()],
});
