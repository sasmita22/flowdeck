import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../../src/adapters/sqlite/open-database.js";
import { SqliteStore } from "../../../src/adapters/sqlite/sqlite-store.js";
import type { NewRun } from "../../../src/ports/store.js";

const newRun = (): NewRun => ({
  buildDir: "/fd/builds/abc",
  inputs: { cwd: "/repo", auto: true },
  nodeIds: ["p1", "p2"],
  session: { tmuxName: "fd-run", cwd: "/repo", claudeSessionId: "c1" },
});

const allMigrations = [
  { name: "001_runs.sql" },
  { name: "002_flows.sql" },
  { name: "003_builds.sql" },
];

describe("openDatabase", () => {
  let folder: string;
  let path: string;
  const opened: { close(): void }[] = [];

  const open = () => {
    const db = openDatabase({ path });
    opened.push(db);
    return db;
  };

  const migrations = (db: Database.Database) =>
    db.prepare("SELECT name FROM migrations ORDER BY name").all();

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "fd-open-db-"));
    path = join(folder, "flowdeck.db");
  });

  afterEach(async () => {
    for (const db of opened.splice(0)) db.close();
    await rm(folder, { recursive: true, force: true });
  });

  it("applies 001_runs.sql, 002_flows.sql and 003_builds.sql to a new database file", () => {
    expect(migrations(open())).toEqual(allMigrations);
  });

  it("applies nothing new when the same file is opened again, and keeps its rows", () => {
    const first = open();
    first.prepare("INSERT INTO flows (id, name, created_at) VALUES ('f1', 'Untitled', 't')").run();

    const second = open();

    expect(migrations(second)).toEqual(allMigrations);
    expect(second.prepare("SELECT id, name FROM flows").all()).toEqual([
      { id: "f1", name: "Untitled" },
    ]);
  });

  it("gives a connection a SqliteStore can create runs and append events on", () => {
    const store = new SqliteStore({ db: open() });
    const { id } = store.createRun(newRun());

    store.append(id, "p1", { kind: "sent" });
    store.append(id, "p1", { kind: "done", payload: { stopMessage: "OK" } });

    expect(store.findRun(id)?.status).toBe("running");
    expect(store.events(id).map((event) => [event.nodeId, event.kind])).toEqual([
      ["p1", "sent"],
      ["p1", "done"],
    ]);
  });

  it("leaves a SqliteStore opened by path migrating its own database", () => {
    const store = new SqliteStore({ path });
    opened.push(store);
    const db = new Database(path);
    opened.push(db);

    expect(migrations(db)).toEqual(allMigrations);
  });
});
