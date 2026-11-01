import { defineConfig } from "vite";
import { nativeModules } from "./native-modules.js";

export default defineConfig({
  build: {
    rollupOptions: { external: nativeModules },
  },
});
