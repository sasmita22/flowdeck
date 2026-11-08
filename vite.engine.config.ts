import { copyFile, cp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { nativeModules } from "./native-modules.js";

const migrationsSource = fileURLToPath(
  new URL("./src/adapters/sqlite/migrations/", import.meta.url),
);

const copyKit = (folder: string): Plugin => ({
  name: `flowdeck-copy-${folder}`,
  async writeBundle(options) {
    const source = fileURLToPath(new URL(`./${folder}/`, import.meta.url));
    await cp(source, join(options.dir ?? ".vite/build", folder), { recursive: true });
  },
});

const copyMigrations = (): Plugin => ({
  name: "flowdeck-copy-migrations",
  async writeBundle(options) {
    const target = join(options.dir ?? ".vite/build", "migrations");
    await mkdir(target, { recursive: true });
    for (const name of await readdir(migrationsSource)) {
      if (name.endsWith(".sql")) await copyFile(join(migrationsSource, name), join(target, name));
    }
  },
});

export default defineConfig({
  build: {
    lib: {
      entry: {
        engine: "src/app/engine/engine.ts",
        "flowdeck-hook": "bin/flowdeck-hook.ts",
        "flowdeck-build-guard": "bin/flowdeck-build-guard.ts",
        "flowdeck-mcp": "bin/flowdeck-mcp.ts",
      },
      fileName: () => "[name].cjs",
      formats: ["cjs"],
    },
    rollupOptions: { external: nativeModules },
  },
  plugins: [copyMigrations(), copyKit("kit"), copyKit("kit-blueprint")],
});
