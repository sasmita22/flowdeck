import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const migrationsSource = fileURLToPath(
  new URL("./src/adapters/sqlite/migrations/", import.meta.url),
);

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
      entry: { engine: "src/app/engine/engine.ts", "flowdeck-hook": "bin/flowdeck-hook.ts" },
      fileName: () => "[name].cjs",
      formats: ["cjs"],
    },
    rollupOptions: { external: ["better-sqlite3"] },
  },
  plugins: [copyMigrations()],
});
