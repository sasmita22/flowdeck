import Database from "better-sqlite3";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../../src/adapters/sqlite/open-database.js";
import { SqliteStore } from "../../../src/adapters/sqlite/sqlite-store.js";
import type { NewBuild, NewRun } from "../../../src/ports/store.js";

const migrationsDir = fileURLToPath(
  new URL("../../../src/adapters/sqlite/migrations/", import.meta.url),
);

const newRun = (): NewRun => ({
  buildDir: "/fd/workspaces/b1",
  inputs: { auto: true },
  nodeIds: ["p1", "p2"],
  session: { tmuxName: "fd-run", cwd: "/repo", claudeSessionId: "c1" },
  buildId: "b1",
});

const newBuild: NewBuild = {
  id: "b1",
  hash: "abc",
  name: "fix-login",
  repo: "/repo",
  base: "main",
  values: {},
  dir: "/fd/workspaces/b1",
  files: [],
  nodes: [],
};

const allMigrations = [
  { name: "001_runs.sql" },
  { name: "002_flows.sql" },
  { name: "003_builds.sql" },
  { name: "004_events_lock.sql" },
  { name: "005_notes.sql" },
  { name: "006_build_lineage.sql" },
  { name: "007_activity.sql" },
  { name: "008_named_builds.sql" },
  { name: "009_build_progress.sql" },
  { name: "010_flow_pinned.sql" },
];

const noTransaction = "-- flowdeck:no-transaction\n";

const parentAndChild = `
CREATE TABLE parent (id TEXT PRIMARY KEY);
CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));
`;

const danglingChildRemoved = `
INSERT INTO child (id, parent_id) VALUES ('c1', 'ghost');
DELETE FROM child;
`;

describe("openDatabase", () => {
  let folder: string;
  let path: string;
  const opened: { close(): void }[] = [];

  const open = (dir?: string) => {
    const db = openDatabase(dir === undefined ? { path } : { path, migrationsDir: dir });
    opened.push(db);
    return db;
  };

  const raw = () => {
    const db = new Database(path);
    opened.push(db);
    return db;
  };

  const migrations = (db: Database.Database) =>
    db.prepare("SELECT name FROM migrations ORDER BY name").all();

  const migrationFolder = async (name: string, files: Record<string, string>) => {
    const dir = join(folder, name);
    await mkdir(dir);
    for (const [file, sql] of Object.entries(files)) await writeFile(join(dir, file), sql);
    return dir;
  };

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "fd-open-db-"));
    path = join(folder, "flowdeck.db");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const db of opened.splice(0)) db.close();
    await rm(folder, { recursive: true, force: true });
  });

  it("applies every migration, 001 to 010, to a new database file", () => {
    expect(migrations(open())).toEqual(allMigrations);
  });

  it("switches the file to WAL, and a read-only connection still opens and reads it", () => {
    const db = open();

    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");

    const readOnly = new Database(path, { readonly: true });
    opened.push(readOnly);
    expect(migrations(readOnly)).toEqual(allMigrations);
  });

  it("waits up to 30 seconds for a lock held by another connection", () => {
    expect(open().pragma("busy_timeout", { simple: true })).toBe(30_000);
  });

  it("switches a new file to WAL once another connection lets go of the write lock it held", () => {
    const holder = raw();
    holder.exec("BEGIN IMMEDIATE");
    const release = () => {
      if (holder.inTransaction) holder.exec("COMMIT");
    };

    const db = openDatabase({ path, pause: release });
    opened.push(db);

    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(migrations(db)).toEqual(allMigrations);
  });

  it.each(["SQLITE_BUSY_RECOVERY", "SQLITE_BUSY_SNAPSHOT"])(
    "retries the WAL switch after a %s lock error",
    (code) => {
      const pragma = Database.prototype.pragma;
      let failures = 1;
      vi.spyOn(Database.prototype, "pragma").mockImplementation(function (
        this: Database.Database,
        ...args: Parameters<Database.Database["pragma"]>
      ) {
        if (args[0] === "journal_mode = WAL" && failures-- > 0) {
          throw new Database.SqliteError("database is locked", code);
        }
        return pragma.apply(this, args);
      });
      const paused: number[] = [];

      const db = openDatabase({ path, pause: (ms) => paused.push(ms) });
      opened.push(db);

      expect(paused).toEqual([10]);
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    },
  );

  it("gives up on the WAL switch with the lock error after 30 seconds of a write lock held throughout", () => {
    const holder = raw();
    holder.exec("BEGIN IMMEDIATE");
    const paused: number[] = [];

    expect(() => openDatabase({ path, pause: (ms) => paused.push(ms) })).toThrow(
      expect.objectContaining({ code: "SQLITE_BUSY" }),
    );
    expect(paused.reduce((sum, ms) => sum + ms, 0)).toBe(30_000);
  });

  it("gives up on the WAL switch after 30 seconds of a read lock held throughout, waiting only between tries", () => {
    const holder = raw();
    holder.exec("CREATE TABLE held (id INTEGER)");
    holder.exec("BEGIN");
    holder.prepare("SELECT * FROM held").all();
    const paused: number[] = [];

    expect(() => openDatabase({ path, pause: (ms) => paused.push(ms) })).toThrow(
      expect.objectContaining({ code: "SQLITE_BUSY" }),
    );
    expect(paused.reduce((sum, ms) => sum + ms, 0)).toBe(30_000);
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
    store.recordBuild(newBuild);
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

    expect(migrations(raw())).toEqual(allMigrations);
  });

  describe("the build progress tables", () => {
    const startPending = (
      db: Database.Database,
      id: string,
      { flowId = "flow-1", name = "fix-login" }: { flowId?: string; name?: string } = {},
    ) =>
      db
        .prepare(
          `INSERT INTO pending_builds (id, flow_id, version, name, origin_json, started_at)
             VALUES (?, ?, 1, ?, '{}', 1)`,
        )
        .run(id, flowId, name);

    const end = (db: Database.Database, id: string) =>
      db.prepare("UPDATE pending_builds SET ended_at = 2, outcome = 'failed' WHERE id = ?").run(id);

    it.each(["build_events", "build_activity"])("keeps %s append-only", (table) => {
      const db = open();
      startPending(db, "pb-1");
      db.prepare(
        `INSERT INTO ${table} (pending_id, seq, at, body_json) VALUES ('pb-1', 1, 1, '{}')`,
      ).run();

      expect(() => db.prepare(`UPDATE ${table} SET body_json = '{"x":1}'`).run()).toThrow(
        /append-only/,
      );
      expect(() => db.prepare(`DELETE FROM ${table}`).run()).toThrow(/append-only/);
      expect(db.prepare(`SELECT body_json FROM ${table}`).all()).toEqual([{ body_json: "{}" }]);
    });

    it("refuses a second open build of the same blueprint", () => {
      const db = open();
      startPending(db, "pb-1", { flowId: "flow-1", name: "first" });

      expect(() => startPending(db, "pb-2", { flowId: "flow-1", name: "second" })).toThrow(
        /UNIQUE/,
      );
    });

    it("refuses a second open build with the same name", () => {
      const db = open();
      startPending(db, "pb-1", { flowId: "flow-1", name: "fix-login" });

      expect(() => startPending(db, "pb-2", { flowId: "flow-2", name: "fix-login" })).toThrow(
        /UNIQUE/,
      );
    });

    it("lets a new build of the same blueprint and name start once the open one has ended", () => {
      const db = open();
      startPending(db, "pb-1");
      end(db, "pb-1");

      startPending(db, "pb-2");

      expect(db.prepare("SELECT id FROM pending_builds WHERE ended_at IS NULL").all()).toEqual([
        { id: "pb-2" },
      ]);
    });

    it.each([
      ["ended_at", 2, 3],
      ["outcome", "built", "failed"],
      ["build_id", "b1", "b2"],
      ["report_json", "{}", '{"x":1}'],
    ])("sets %s once and never changes it", (column, first, second) => {
      const db = open();
      startPending(db, "pb-1");
      const set = (value: string | number) =>
        db.prepare(`UPDATE pending_builds SET ${column} = ? WHERE id = 'pb-1'`).run(value);

      set(first);

      expect(() => set(second)).toThrow();
      expect(() =>
        db.prepare(`UPDATE pending_builds SET ${column} = NULL WHERE id = 'pb-1'`).run(),
      ).toThrow();
      expect(db.prepare(`SELECT ${column} AS value FROM pending_builds`).get()).toEqual({
        value: first,
      });
    });
  });

  describe("a migration marked to run outside a transaction", () => {
    it("runs an unmarked migration with foreign keys on, so a dangling row is refused at once", async () => {
      const dir = await migrationFolder("unmarked", {
        "001_tables.sql": parentAndChild,
        "002_dangling.sql": danglingChildRemoved,
      });

      expect(() => open(dir)).toThrow(/FOREIGN KEY/);
    });

    it("runs a marked migration with foreign keys off, records it, then turns them back on", async () => {
      const dir = await migrationFolder("marked", {
        "001_tables.sql": parentAndChild,
        "002_dangling.sql": noTransaction + danglingChildRemoved,
        "003_after.sql": "CREATE TABLE after_marked (id TEXT);",
      });

      const db = open(dir);

      expect(migrations(db)).toEqual([
        { name: "001_tables.sql" },
        { name: "002_dangling.sql" },
        { name: "003_after.sql" },
      ]);
      expect(db.prepare("SELECT count(*) AS n FROM child").get()).toEqual({ n: 0 });
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(() =>
        db.prepare("INSERT INTO child (id, parent_id) VALUES ('c1', 'ghost')").run(),
      ).toThrow(/FOREIGN KEY/);
    });

    it("aborts a marked migration that leaves a dangling reference, recording and keeping none of it", async () => {
      const dir = await migrationFolder("dangling", {
        "001_tables.sql": parentAndChild,
        "002_dangling.sql": noTransaction + danglingChildRemoved,
        "003_dangling.sql": `${noTransaction}INSERT INTO child (id, parent_id) VALUES ('c2', 'ghost');`,
      });

      expect(() => open(dir)).toThrow();

      const db = raw();
      expect(migrations(db)).toEqual([{ name: "001_tables.sql" }, { name: "002_dangling.sql" }]);
      expect(db.prepare("SELECT count(*) AS n FROM child").get()).toEqual({ n: 0 });
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    });
  });

  describe("migrating a database made by 001 to 007 to 008", () => {
    const stage = async (name: string, before: string) => {
      const dir = join(folder, name);
      await mkdir(dir);
      for (const file of (await readdir(migrationsDir)).filter((each) => each < before)) {
        await copyFile(join(migrationsDir, file), join(dir, file));
      }
      return dir;
    };

    const tables = [
      "flows",
      "flow_versions",
      "builds",
      "build_files",
      "build_nodes",
      "runs",
      "run_sessions",
      "run_nodes",
      "events",
      "activity",
    ];

    const seedOldDatabase = async () => {
      const beforeLineage = openDatabase({ path, migrationsDir: await stage("to-005", "006") });
      beforeLineage.exec(`
        INSERT INTO flows (id, name, created_at) VALUES ('flow-1', 'Fix login', 't0');
        INSERT INTO flow_versions (flow_id, version, session, saved_at) VALUES ('flow-1', 1, '{}', 't0');
        INSERT INTO builds (hash, dir, created_at) VALUES ('old', '/fd/builds/old', 5);
        INSERT INTO runs (id, build_dir, inputs, status, created_at, build_hash)
          VALUES ('r-none', '/fd/builds/gone', '{"cwd":"/repo"}', 'done', 't1', NULL),
                 ('r-old', '/fd/builds/old', '{}', 'failed', 't2', 'old');
        INSERT INTO run_sessions (id, run_id, tmux_name, cwd, claude_session_id, status)
          VALUES (1, 'r-none', 'fd-a', '/repo', 'c1', 'closed'),
                 (2, 'r-old', 'fd-b', '/repo', 'c2', 'closed');
        INSERT INTO run_nodes (run_id, node_id, session_id) VALUES ('r-none', 'p1', 1), ('r-old', 'p1', 2);
        INSERT INTO events (run_id, node_id, kind, time)
          VALUES ('r-none', 'p1', 'sent', 't'), ('r-old', 'p1', 'failed', 't');
      `);
      beforeLineage.close();

      const before008 = openDatabase({ path, migrationsDir: await stage("to-007", "008") });
      before008.exec(`
        BEGIN;
        INSERT INTO build_files (build_hash, path, sha256)
          VALUES ('h1', 'commands/p1.md', 'a1'), ('h1', 'manifest.json', 'm1');
        INSERT INTO build_nodes (build_hash, ordinal, node_id, type, config, file)
          VALUES ('h1', 0, 'p1', 'prompt', '{}', 'commands/p1.md'), ('h1', 1, 's1', 'script', '{}', NULL);
        INSERT INTO builds (hash, dir, created_at, flow_id, version)
          VALUES ('h1', '/fd/builds/h1', 9, 'flow-1', 1);
        INSERT INTO runs (id, build_dir, inputs, status, created_at, build_hash)
          VALUES ('r-a', '/fd/builds/h1', '{}', 'running', 't3', 'h1'),
                 ('r-b', '/fd/builds/h1', '{}', 'running', 't4', 'h1');
        INSERT INTO run_sessions (id, run_id, tmux_name, cwd, claude_session_id, status)
          VALUES (3, 'r-a', 'fd-c', '/repo', 'c3', 'open'), (4, 'r-b', 'fd-d', '/repo', 'c4', 'open');
        INSERT INTO run_nodes (run_id, node_id, session_id) VALUES ('r-a', 'p1', 3), ('r-b', 's1', 4);
        INSERT INTO activity (run_id, id, node_id, entry) VALUES ('r-a', 1, 'p1', '{}');
        COMMIT;
      `);
      const before = Object.fromEntries(
        tables.map((table) => [table, before008.prepare(`SELECT * FROM ${table}`).all()]),
      ) as Record<string, Record<string, unknown>[]>;
      before008.close();
      return before;
    };

    const withBuildId = (rows: Record<string, unknown>[]) =>
      rows.map(({ build_hash, ...rest }) => ({ ...rest, build_id: build_hash }));

    it("records 008 and keeps every row, the build hash now the build id", async () => {
      const before = await seedOldDatabase();

      const db = open();

      expect(migrations(db)).toEqual(allMigrations);
      expect(db.prepare("SELECT * FROM flows").all(), "flows").toEqual(
        (before["flows"] ?? []).map((row) => ({ ...row, pinned: 0 })),
      );
      for (const table of ["flow_versions", "run_sessions", "run_nodes", "events", "activity"]) {
        expect(db.prepare(`SELECT * FROM ${table}`).all(), table).toEqual(before[table]);
      }
      for (const table of ["runs", "build_files", "build_nodes"]) {
        expect(db.prepare(`SELECT * FROM ${table}`).all(), table).toEqual(
          withBuildId(before[table] ?? []),
        );
      }
    });

    it("gives every old build its hash as its id and no name, repo, base, values or deletion", async () => {
      await seedOldDatabase();

      const db = open();

      expect(
        db
          .prepare(
            `SELECT id, hash, name, repo, base, "values", deleted_at, dir, created_at, flow_id, version
               FROM builds ORDER BY created_at`,
          )
          .all(),
      ).toEqual([
        {
          id: "old",
          hash: "old",
          name: null,
          repo: null,
          base: null,
          values: null,
          deleted_at: null,
          dir: "/fd/builds/old",
          created_at: 5,
          flow_id: null,
          version: null,
        },
        {
          id: "h1",
          hash: "h1",
          name: null,
          repo: null,
          base: null,
          values: null,
          deleted_at: null,
          dir: "/fd/builds/h1",
          created_at: 9,
          flow_id: "flow-1",
          version: 1,
        },
      ]);
    });

    it("keeps both running runs of one build running", async () => {
      await seedOldDatabase();

      const db = open();

      expect(
        db.prepare("SELECT id, status FROM runs WHERE build_id = 'h1' ORDER BY id").all(),
      ).toEqual([
        { id: "r-a", status: "running" },
        { id: "r-b", status: "running" },
      ]);
    });

    it("points runs, build files and build nodes at the build id, with foreign keys on and whole", async () => {
      await seedOldDatabase();

      const db = open();
      const references = (table: string) =>
        (
          db.prepare(`SELECT "table", "from", "to" FROM pragma_foreign_key_list(?)`).all(table) as {
            table: string;
            from: string;
            to: string;
          }[]
        ).map((key) => `${key.from} -> ${key.table}.${key.to}`);

      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(references("runs")).toEqual(["build_id -> builds.id"]);
      expect(references("build_files")).toEqual(["build_id -> builds.id"]);
      expect(references("build_nodes")).toEqual(
        expect.arrayContaining(["build_id -> builds.id", "build_id -> build_files.build_id"]),
      );
      expect(references("run_sessions")).toContain("run_id -> runs.id");
      expect(references("run_nodes")).toContain("run_id -> runs.id");
      expect(references("activity")).toEqual(["run_id -> runs.id"]);
      expect(() =>
        db
          .prepare(
            "INSERT INTO runs (id, build_dir, inputs, status, created_at, build_id) VALUES ('r-x', '/b', '{}', 'done', 't', 'ghost')",
          )
          .run(),
      ).toThrow(/FOREIGN KEY/);
    });
  });
});
