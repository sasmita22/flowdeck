import Database from "better-sqlite3";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type OpenDatabaseOptions = { path: string; migrationsDir?: string; now?: () => Date };

export function openDatabase(options: OpenDatabaseOptions): Database.Database {
  mkdirSync(dirname(options.path), { recursive: true });
  const db = new Database(options.path);
  db.pragma("foreign_keys = ON");
  migrate(
    db,
    options.migrationsDir ?? fileURLToPath(new URL("./migrations/", import.meta.url)),
    options.now ?? (() => new Date()),
  );
  return db;
}

function migrate(db: Database.Database, migrationsDir: string, now: () => Date): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (db.prepare("SELECT name FROM migrations").all() as { name: string }[]).map((row) => row.name),
  );
  const pending = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql") && !applied.has(name))
    .sort();
  for (const name of pending) {
    const sql = readFileSync(join(migrationsDir, name), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO migrations (name, applied_at) VALUES (?, ?)").run(
        name,
        now().toISOString(),
      );
    })();
  }
}
