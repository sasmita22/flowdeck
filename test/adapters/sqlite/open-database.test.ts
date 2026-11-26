import Database from "better-sqlite3";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type MigrationReport } from "../../../src/adapters/sqlite/open-database.js";
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
  branch: "flowdeck/fix-login",
  branchCreated: true,
  values: {},
  dir: "/fd/workspaces/b1",
  files: [],
  nodes: [],
  manifest: "{}",
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
  { name: "011_build_snapshots.sql" },
  { name: "012_drop_pending_builds_one_per_flow.sql" },
  { name: "013_flows_deleted_at.sql" },
  { name: "014_build_branch.sql" },
  { name: "015_build_manifests.sql" },
  { name: "016_events_by_node.sql" },
  { name: "017_run_stories.sql" },
  { name: "018_runs_deleted_at.sql" },
  { name: "019_runs_own_their_build.sql" },
  { name: "020_run_repo_states_and_step_texts.sql" },
  { name: "021_complete_deletes_and_build_texts.sql" },
  { name: "022_clean_start.sql" },
  { name: "023_containers_clean_start.sql" },
  { name: "024_build_worktrees_clean_start.sql" },
  { name: "025_connections.sql" },
  { name: "026_build_snapshot_flow.sql" },
];

const migrationsTo021 = allMigrations.filter(({ name }) => name < "022");

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

  const stage = async (name: string, before: string) => {
    const dir = join(folder, name);
    await mkdir(dir);
    for (const file of (await readdir(migrationsDir)).filter((each) => each < before)) {
      await copyFile(join(migrationsDir, file), join(dir, file));
    }
    return dir;
  };

  const openTo021 = async () => open(await stage("to-021", "022"));

  const openReporting = (dir?: string) => {
    const reports: MigrationReport[] = [];
    const db = openDatabase({
      path,
      ...(dir === undefined ? {} : { migrationsDir: dir }),
      onMigrated: (report) => reports.push(report),
    });
    opened.push(db);
    return { db, reports };
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

  it("applies every migration, 001 to 013, to a new database file", () => {
    expect(migrations(open())).toEqual(allMigrations);
  });

  it("indexes events by run, node and order", () => {
    expect(
      open().prepare("SELECT name FROM pragma_index_info('events_by_node') ORDER BY seqno").all(),
    ).toEqual([{ name: "run_id" }, { name: "node_id" }, { name: "seq" }]);
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

    it.each(["build_events", "build_activity"])(
      "refuses a change to %s and lets its rows be deleted",
      (table) => {
        const db = open();
        startPending(db, "pb-1");
        db.prepare(
          `INSERT INTO ${table} (pending_id, seq, at, body_json) VALUES ('pb-1', 1, 1, '{}')`,
        ).run();

        expect(() => db.prepare(`UPDATE ${table} SET body_json = '{"x":1}'`).run()).toThrow(
          /append-only/,
        );
        expect(db.prepare(`SELECT body_json FROM ${table}`).all()).toEqual([{ body_json: "{}" }]);

        db.prepare(`DELETE FROM ${table}`).run();

        expect(db.prepare(`SELECT body_json FROM ${table}`).all()).toEqual([]);
      },
    );

    it("a second open build of the same blueprint under another name inserts", () => {
      const db = open();
      startPending(db, "pb-1", { flowId: "flow-1", name: "first" });

      startPending(db, "pb-2", { flowId: "flow-1", name: "second" });

      expect(
        db.prepare("SELECT id FROM pending_builds WHERE ended_at IS NULL ORDER BY id").all(),
      ).toEqual([{ id: "pb-1" }, { id: "pb-2" }]);
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

      const db = await openTo021();

      expect(migrations(db)).toEqual(migrationsTo021);
      expect(db.prepare("SELECT * FROM flows").all(), "flows").toEqual(
        (before["flows"] ?? []).map((row) => ({ ...row, pinned: 0, deleted_at: null })),
      );
      for (const table of ["flow_versions", "run_sessions", "run_nodes", "events", "activity"]) {
        expect(db.prepare(`SELECT * FROM ${table}`).all(), table).toEqual(before[table]);
      }
      expect(
        db
          .prepare(
            "SELECT id, build_dir, inputs, status, total_cost, created_at, build_id, deleted_at FROM runs",
          )
          .all(),
        "runs",
      ).toEqual(withBuildId(before["runs"] ?? []).map((row) => ({ ...row, deleted_at: null })));
      for (const table of ["build_files", "build_nodes"]) {
        expect(db.prepare(`SELECT * FROM ${table}`).all(), table).toEqual(
          withBuildId(before[table] ?? []),
        );
      }
    });

    it("gives every old build its hash as its id and no name, repo, base, values or deletion", async () => {
      await seedOldDatabase();

      const db = await openTo021();

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

      const db = await openTo021();

      expect(
        db.prepare("SELECT id, status FROM runs WHERE build_id = 'h1' ORDER BY id").all(),
      ).toEqual([
        { id: "r-a", status: "running" },
        { id: "r-b", status: "running" },
      ]);
    });

    it("points runs, build files and build nodes at the build id, with foreign keys on and whole", async () => {
      await seedOldDatabase();

      const db = await openTo021();
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
      expect(references("runs")).toEqual([]);
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
      ).toThrow(/a run names a recorded build/);
    });
  });

  describe("migrating a database made by 001 to 018 to 019", () => {
    const seedBefore019 = async () => {
      const before = openDatabase({ path, migrationsDir: await stage("to-018", "019") });
      before.exec(`
        BEGIN;
        INSERT INTO build_files (build_id, path, sha256)
          VALUES ('b-live', 'commands/p1.md', 'a1'), ('b-gone', 'commands/p1.md', 'a2');
        INSERT INTO build_nodes (build_id, ordinal, node_id, type, config, file)
          VALUES ('b-live', 0, 'p1', 'prompt', '{}', 'commands/p1.md'),
                 ('b-gone', 0, 'p1', 'prompt', '{}', 'commands/p1.md');
        INSERT INTO builds (id, hash, name, repo, base, "values", dir, created_at, flow_id, version, branch, branch_created)
          VALUES ('b-live', 'h-live', 'fix-login', '/repo', 'main', '{"ticket":"FD-1"}', '/fd/workspaces/b-live', 1, 'flow-1', 3, 'flowdeck/fix-login', 1),
                 ('b-gone', 'h-gone', 'old-try', '/repo2', 'dev', '{}', '/fd/workspaces/b-gone', 2, 'flow-2', 1, 'flowdeck/old-try', 0);
        COMMIT;
        INSERT INTO build_manifests (build_id, manifest_json) VALUES ('b-live', '{"nodes":[]}');
        INSERT INTO pending_builds (id, flow_id, version, name, origin_json, started_at, ended_at, outcome, build_id)
          VALUES ('pb-live', 'flow-1', 3, 'fix-login', '{}', 1, 2, 'built', 'b-live'),
                 ('pb-gone', 'flow-2', 1, 'old-try', '{}', 1, 2, 'built', 'b-gone');
        INSERT INTO build_snapshots (pending_id, build_id, blueprint_name, version, svg, created_at)
          VALUES ('pb-live', 'b-live', 'Fix login', 3, '<svg/>', 1),
                 ('pb-gone', 'b-gone', 'Old try', 1, '<svg/>', 2);
        INSERT INTO build_events (pending_id, seq, at, body_json)
          VALUES ('pb-live', 1, 1, '{}'), ('pb-gone', 1, 1, '{}');
        INSERT INTO build_activity (pending_id, seq, at, body_json)
          VALUES ('pb-live', 1, 1, '{}'), ('pb-gone', 1, 1, '{}');
        INSERT INTO runs (id, build_dir, inputs, status, total_cost, created_at, build_id)
          VALUES ('r-live', '/fd/workspaces/b-live', '{}', 'done', 0.5, 't1', 'b-live'),
                 ('r-gone', '/fd/workspaces/b-gone', '{}', 'failed', 0.2, 't2', 'b-gone');
        INSERT INTO run_sessions (id, run_id, tmux_name, cwd, claude_session_id, status)
          VALUES (1, 'r-live', 'fd-a', '/repo', 'c1', 'closed'), (2, 'r-gone', 'fd-b', '/repo2', 'c2', 'closed');
        INSERT INTO run_nodes (run_id, node_id, session_id) VALUES ('r-live', 'p1', 1), ('r-gone', 'p1', 2);
        INSERT INTO events (run_id, node_id, kind, time)
          VALUES ('r-live', 'p1', 'sent', 't'), ('r-gone', 'p1', 'failed', 't');
        INSERT INTO activity (run_id, id, node_id, entry)
          VALUES ('r-live', 1, 'p1', '{}'), ('r-gone', 1, 'p1', '{}');
        INSERT INTO run_stories (run_id, at, run_status, text, cost)
          VALUES ('r-live', 't', 'done', 'It worked.', 0.01), ('r-gone', 't', 'failed', 'It broke.', 0.01);
        UPDATE builds SET deleted_at = 9 WHERE id = 'b-gone';
      `);
      before.close();
    };

    const ids = (db: Database.Database, sql: string) =>
      (db.prepare(sql).pluck().all() as string[]).sort();

    it("keeps both runs and every row under them, each run with its copy of its build", async () => {
      await seedBefore019();

      const db = await openTo021();

      expect(
        db
          .prepare(
            `SELECT id, build_id, build_name, build_hash, blueprint_name, flow_id, flow_version,
                    repo, branch, build_values, manifest_json
               FROM runs ORDER BY id`,
          )
          .all(),
      ).toEqual([
        {
          id: "r-gone",
          build_id: "b-gone",
          build_name: "old-try",
          build_hash: "h-gone",
          blueprint_name: "Old try",
          flow_id: "flow-2",
          flow_version: 1,
          repo: "/repo2",
          branch: "flowdeck/old-try",
          build_values: "{}",
          manifest_json: null,
        },
        {
          id: "r-live",
          build_id: "b-live",
          build_name: "fix-login",
          build_hash: "h-live",
          blueprint_name: "Fix login",
          flow_id: "flow-1",
          flow_version: 3,
          repo: "/repo",
          branch: "flowdeck/fix-login",
          build_values: '{"ticket":"FD-1"}',
          manifest_json: '{"nodes":[]}',
        },
      ]);
      for (const table of ["run_sessions", "run_nodes", "events", "activity", "run_stories"]) {
        expect(ids(db, `SELECT run_id FROM ${table}`), table).toEqual(["r-gone", "r-live"]);
      }
    });

    it("purges the deleted build and every row it owns, keeping its run, with no broken foreign key", async () => {
      await seedBefore019();

      const db = await openTo021();

      for (const table of [
        "build_files",
        "build_nodes",
        "build_manifests",
        "build_snapshots",
        "pending_builds",
      ]) {
        expect(ids(db, `SELECT build_id FROM ${table}`), table).toEqual(["b-live"]);
      }
      expect(ids(db, "SELECT id FROM builds")).toEqual(["b-live"]);
      for (const table of ["build_events", "build_activity"]) {
        expect(ids(db, `SELECT pending_id FROM ${table}`), table).toEqual(["pb-live"]);
      }
      expect(ids(db, "SELECT id FROM runs")).toEqual(["r-gone", "r-live"]);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });

    it.each([
      { table: "build_nodes", first: [] },
      { table: "build_files", first: ["build_nodes"] },
      { table: "build_manifests", first: [] },
      { table: "build_snapshots", first: [] },
      { table: "builds", first: ["build_nodes", "build_files"] },
    ])("lets $table rows be deleted", async ({ table, first }) => {
      await seedBefore019();
      const db = await openTo021();
      for (const each of first) db.exec(`DELETE FROM ${each}`);

      db.exec(`DELETE FROM ${table}`);

      expect(db.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0);
    });

    it("keeps the run triggers firing after the rebuild", async () => {
      await seedBefore019();
      const db = await openTo021();
      const insertRun = (id: string, status: string) =>
        db
          .prepare(
            "INSERT INTO runs (id, build_dir, inputs, status, created_at, build_id) VALUES (?, '/b', '{}', ?, 't', 'b-live')",
          )
          .run(id, status);

      expect(() => insertRun("r-live", "done")).toThrow(/a run is never replaced/);
      expect(() => db.exec("UPDATE runs SET build_id = 'b-other' WHERE id = 'r-live'")).toThrow(
        /the build a run names is locked/,
      );
      insertRun("r-running", "running");
      expect(() => insertRun("r-second", "running")).toThrow(/build is running/);
      expect(() => db.exec("UPDATE runs SET status = 'running' WHERE id = 'r-live'")).toThrow(
        /build is running/,
      );
      db.exec("UPDATE runs SET deleted_at = 1 WHERE id = 'r-live'");
      expect(() => db.exec("UPDATE runs SET deleted_at = 2 WHERE id = 'r-live'")).toThrow(
        /a run is deleted once/,
      );
    });
  });
  describe("migrating a database made by 001 to 020 to 021", () => {
    const seedBefore021 = async () => {
      const before = openDatabase({ path, migrationsDir: await stage("to-020", "021") });
      before.exec(`
        INSERT INTO builds (id, hash, name, repo, base, "values", dir, created_at, branch, branch_created)
          VALUES ('b1', 'h1', 'fix-login', '/repo', 'main', '{}', '/fd/workspaces/b1', 1, 'flowdeck/fix-login', 1),
                 ('b2', 'h2', 'fix-signup', '/repo', 'main', '{}', '/fd/workspaces/b2', 2, 'flowdeck/fix-signup', 1);
        INSERT INTO runs (id, build_dir, inputs, status, created_at, build_id)
          VALUES ('r1', '/b1', '{}', 'done', 't1', 'b1'),
                 ('r4', '/b2', '{}', 'done', 't2', 'b2'),
                 ('r2', '/b1', '{}', 'failed', 't3', 'b1'),
                 ('r3', '/b1', '{}', 'done', 't4', 'b1');
        INSERT INTO run_sessions (id, run_id, tmux_name, cwd, claude_session_id, status, parent)
          VALUES (1, 'r1', 'fd-a', '/repo', 'c1', 'closed', NULL),
                 (2, 'r2', 'fd-b', '/repo', 'c2', 'closed', NULL),
                 (3, 'r2', 'fd-b', '/repo', 'c3', 'closed', 2);
        INSERT INTO run_nodes (run_id, node_id, session_id) VALUES ('r1', 'p1', 1), ('r2', 'p1', 3);
        INSERT INTO events (run_id, node_id, kind, time)
          VALUES ('r1', 'p1', 'sent', 't'), ('r2', 'p1', 'failed', 't');
        INSERT INTO activity (run_id, id, node_id, entry)
          VALUES ('r1', 1, 'p1', '{}'), ('r2', 1, 'p1', '{}');
        INSERT INTO run_stories (run_id, at, run_status, text, cost)
          VALUES ('r1', 't', 'done', 'It worked.', 0.01), ('r2', 't', 'failed', 'It broke.', 0.01);
        INSERT INTO run_repo_states (run_id, phase, state_json, other_repos_json, at)
          VALUES ('r1', 'before', '{}', '[]', 1), ('r2', 'after', '{}', '[]', 1);
        INSERT INTO step_texts (run_id, entry_id, field, text, at)
          VALUES ('r1', 1, 'output', 'kept', 1), ('r2', 1, 'output', 'gone', 1);
        UPDATE runs SET deleted_at = 9 WHERE id = 'r2';
        INSERT INTO pending_builds (id, flow_id, version, name, origin_json, started_at, ended_at, outcome)
          VALUES ('pb-going', 'flow-1', 1, 'nightly', '{}', 0, NULL, NULL),
                 ('pb-older', 'flow-1', 1, 'nightly', '{}', 1, 2, 'failed'),
                 ('pb-gone', 'flow-1', 1, 'nightly', '{}', 3, 4, 'stopped'),
                 ('pb-later', 'flow-1', 1, 'nightly', '{}', 5, 6, 'failed'),
                 ('pb-weekly', 'flow-2', 1, 'weekly', '{}', 1, 2, 'failed');
        INSERT INTO build_snapshots (pending_id, build_id, blueprint_name, version, svg, created_at)
          VALUES ('pb-going', NULL, 'Nightly', 1, '<svg/>', 0),
                 ('pb-older', NULL, 'Nightly', 1, '<svg/>', 1),
                 ('pb-gone', NULL, 'Nightly', 1, '<svg/>', 3),
                 ('pb-later', NULL, 'Nightly', 1, '<svg/>', 5),
                 ('pb-weekly', NULL, 'Weekly', 1, '<svg/>', 1);
        INSERT INTO build_events (pending_id, seq, at, body_json)
          VALUES ('pb-going', 1, 1, '{}'), ('pb-older', 1, 1, '{}'), ('pb-gone', 1, 1, '{}'),
                 ('pb-later', 1, 1, '{}'), ('pb-weekly', 1, 1, '{}');
        INSERT INTO build_activity (pending_id, seq, at, body_json)
          VALUES ('pb-going', 1, 1, '{}'), ('pb-older', 1, 1, '{}'), ('pb-gone', 1, 1, '{}'),
                 ('pb-later', 1, 1, '{}'), ('pb-weekly', 1, 1, '{}');
        UPDATE pending_builds SET deleted_at = 9 WHERE id = 'pb-gone';
      `);
      before.close();
    };

    const ids = (db: Database.Database, sql: string) =>
      (db.prepare(sql).pluck().all() as string[]).sort();

    it("stores every run's number as it was shown, and counts each build's numbers so far", async () => {
      await seedBefore021();

      const db = await openTo021();

      expect(db.prepare("SELECT id, number FROM runs ORDER BY id").all()).toEqual([
        { id: "r1", number: 1 },
        { id: "r3", number: 3 },
        { id: "r4", number: 1 },
      ]);
      expect(
        db.prepare("SELECT build_id, last FROM run_number_counters ORDER BY build_id").all(),
      ).toEqual([
        { build_id: "b1", last: 3 },
        { build_id: "b2", last: 1 },
      ]);
    });

    it("removes every row of a deleted run and keeps every row of the others", async () => {
      await seedBefore021();

      const db = await openTo021();

      for (const table of [
        "step_texts",
        "run_repo_states",
        "run_stories",
        "activity",
        "events",
        "run_nodes",
        "run_sessions",
      ]) {
        expect(ids(db, `SELECT DISTINCT run_id FROM ${table}`), table).toEqual(["r1"]);
      }
      expect(ids(db, "SELECT id FROM runs")).toEqual(["r1", "r3", "r4"]);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });

    it("removes a deleted pending build and the older ended attempts of its name, keeping the open one, a later one and other names", async () => {
      await seedBefore021();

      const db = await openTo021();

      const kept = ["pb-going", "pb-later", "pb-weekly"];
      expect(ids(db, "SELECT id FROM pending_builds")).toEqual(kept);
      for (const table of ["build_activity", "build_events", "build_snapshots"]) {
        expect(ids(db, `SELECT pending_id FROM ${table}`), table).toEqual(kept);
      }
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });

    it("adds an optional repo to run repo states, and a build step text table that refuses edits", async () => {
      await seedBefore021();

      const db = await openTo021();

      expect(
        db
          .prepare(
            "SELECT name, \"notnull\" FROM pragma_table_info('run_repo_states') WHERE name = 'repo'",
          )
          .all(),
      ).toEqual([{ name: "repo", notnull: 0 }]);
      db.exec(
        "INSERT INTO build_step_texts (pending_id, entry_id, field, text, at) VALUES ('pb-later', 1, 'output', 'full', 1)",
      );
      expect(() => db.exec("UPDATE build_step_texts SET text = 'edited'")).toThrow(/append-only/);
      expect(() =>
        db.exec(
          "INSERT OR REPLACE INTO build_step_texts (id, pending_id, entry_id, field, text, at) SELECT id, 'pb-later', 1, 'output', 'replaced', 1 FROM build_step_texts",
        ),
      ).toThrow(/append-only/);
      expect(() =>
        db.exec(
          "INSERT INTO build_step_texts (pending_id, entry_id, field, text, at) VALUES ('pb-later', 1, 'notes', 'x', 1)",
        ),
      ).toThrow(/CHECK/);
      expect(db.prepare("SELECT text FROM build_step_texts").pluck().all()).toEqual(["full"]);
    });

    it.each(["events", "activity", "run_stories", "run_repo_states", "step_texts"])(
      "still refuses to delete a %s row of a run that is not deleted",
      async (table) => {
        await seedBefore021();
        const db = await openTo021();

        expect(() => db.exec(`DELETE FROM ${table} WHERE run_id = 'r1'`)).toThrow(/append-only/);
        expect(ids(db, `SELECT run_id FROM ${table} WHERE run_id = 'r1'`)).toEqual(["r1"]);
      },
    );
  });

  const everyTable = [
    "flows",
    "flow_versions",
    "nodes",
    "ports",
    "wires",
    "builds",
    "build_files",
    "build_nodes",
    "build_manifests",
    "build_snapshots",
    "pending_builds",
    "build_events",
    "build_activity",
    "build_step_texts",
    "runs",
    "run_sessions",
    "run_nodes",
    "events",
    "activity",
    "run_stories",
    "run_repo_states",
    "step_texts",
    "run_number_counters",
  ];

  const count = (db: Database.Database, table: string) =>
    db.prepare(`SELECT count(*) FROM ${table}`).pluck().get();

  const seedEveryTableBefore = async (migration: string) => {
    const before = openDatabase({
      path,
      migrationsDir: await stage(`before-${migration}`, migration),
    });
    before.exec(`
      BEGIN;
      INSERT INTO flows (id, name, created_at) VALUES ('f1', 'old', 't');
      INSERT INTO nodes (flow_id, version, ordinal, id, type, label, x, y, parent, settings)
        VALUES ('f1', 1, 0, 'p1', 'agent', 'Plan', 0, 0, NULL, '{}');
      INSERT INTO ports (flow_id, version, node_id, ordinal, name, direction, kind)
        VALUES ('f1', 1, 'p1', 0, 'in', 'in', 'then');
      INSERT INTO wires (flow_id, version, ordinal, kind, from_node, from_port, to_node, to_port, file)
        VALUES ('f1', 1, 0, 'then', 'p1', 'out', 'p1', 'in', NULL);
      INSERT INTO flow_versions (flow_id, version, session, saved_at) VALUES ('f1', 1, '{}', 't');
      INSERT INTO build_files (build_id, path, sha256) VALUES ('b1', 'manifest.json', 'sha');
      INSERT INTO build_nodes (build_id, ordinal, node_id, type, config, file)
        VALUES ('b1', 0, 'p1', 'agent', '{}', 'manifest.json');
      INSERT INTO builds (id, hash, name, repo, base, "values", dir, created_at, flow_id, version, branch, branch_created)
        VALUES ('b1', 'h1', 'fix-login', '/repo', 'main', '{}', '/fd/workspaces/b1', 1, 'f1', 1, 'flowdeck/fix-login', 1);
      INSERT INTO build_manifests (build_id, manifest_json) VALUES ('b1', '{}');
      INSERT INTO pending_builds (id, flow_id, version, name, origin_json, started_at, ended_at, outcome)
        VALUES ('pb1', 'f1', 1, 'fix-login', '{}', 0, 1, 'built');
      INSERT INTO build_snapshots (pending_id, build_id, blueprint_name, version, svg, created_at)
        VALUES ('pb1', 'b1', 'old', 1, '<svg/>', 0);
      INSERT INTO build_events (pending_id, seq, at, body_json) VALUES ('pb1', 1, 1, '{}');
      INSERT INTO build_activity (pending_id, seq, at, body_json) VALUES ('pb1', 1, 1, '{}');
      INSERT INTO build_step_texts (pending_id, entry_id, field, text, at)
        VALUES ('pb1', 1, 'output', 'full', 1);
      INSERT INTO runs (id, build_dir, inputs, status, created_at, build_id)
        VALUES ('r1', '/fd/workspaces/b1', '{}', 'done', 't', 'b1');
      INSERT INTO run_sessions (id, run_id, tmux_name, cwd, claude_session_id, status, parent)
        VALUES (1, 'r1', 'fd-run-a', '/repo', 'c1', 'closed', NULL);
      INSERT INTO run_nodes (run_id, node_id, session_id) VALUES ('r1', 'p1', 1);
      INSERT INTO events (run_id, node_id, kind, time) VALUES ('r1', 'p1', 'sent', 't');
      INSERT INTO activity (run_id, id, node_id, entry) VALUES ('r1', 1, 'p1', '{}');
      INSERT INTO run_stories (run_id, at, run_status, text, cost)
        VALUES ('r1', 't', 'done', 'It worked.', 0.01);
      INSERT INTO run_repo_states (run_id, phase, state_json, other_repos_json, at)
        VALUES ('r1', 'before', '{}', '[]', 1);
      INSERT INTO step_texts (run_id, entry_id, field, text, at) VALUES ('r1', 1, 'output', 'kept', 1);
      INSERT INTO run_number_counters (build_id, last) VALUES ('b1', 1);
      COMMIT;
    `);
    for (const table of everyTable) expect(count(before, table), table).toBe(1);
    before.close();
  };

  describe("migrating a database made by 001 to 021 to 022", () => {
    const seedBefore022 = () => seedEveryTableBefore("022");

    it("deletes every blueprint, build and run, leaving no broken foreign key", async () => {
      await seedBefore022();

      const db = open();

      for (const table of everyTable) expect(count(db, table), table).toBe(0);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(migrations(db)).toEqual(allMigrations);
    });

    it("reports 022 as applied in this open, on a database that existed before it", async () => {
      await seedBefore022();

      const { reports } = openReporting(await stage("to-022", "023"));

      expect(reports).toEqual([{ applied: ["022_clean_start"], existedBefore: true }]);
    });

    it("reports nothing applied when the database is opened again after 022", async () => {
      await seedBefore022();
      openReporting().db.close();

      const { reports } = openReporting();

      expect(reports).toEqual([{ applied: [], existedBefore: true }]);
    });

    it("gives saved blueprint versions a settings column", async () => {
      await seedBefore022();

      const db = open();

      expect(
        db.prepare("SELECT name FROM pragma_table_info('flow_versions')").pluck().all(),
      ).toContain("settings");
    });
  });

  describe("migrating a database made by 001 to 022 to 023", () => {
    const seedBefore023 = () => seedEveryTableBefore("023");

    it("deletes every blueprint, build and run, leaving no broken foreign key", async () => {
      await seedBefore023();

      const db = open();

      for (const table of everyTable) expect(count(db, table), table).toBe(0);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(migrations(db)).toEqual(allMigrations);
    });

    it("reports 023 as applied in this open, on a database that existed before it", async () => {
      await seedBefore023();

      const { reports } = openReporting(await stage("to-023", "024"));

      expect(reports).toEqual([{ applied: ["023_containers_clean_start"], existedBefore: true }]);
    });

    it("gives saved blueprint versions a containers column that defaults to an empty list", async () => {
      await seedBefore023();

      const db = open();

      expect(
        db
          .prepare(
            "SELECT \"notnull\" AS required, dflt_value AS fallback FROM pragma_table_info('flow_versions') WHERE name = 'containers'",
          )
          .get(),
      ).toEqual({ required: 1, fallback: "'[]'" });
    });

    it("keeps saved blueprint versions locked against deletes", async () => {
      await seedBefore023();
      const db = open();
      db.exec(`
        INSERT INTO flows (id, name, created_at) VALUES ('f2', 'new', 't');
        INSERT INTO flow_versions (flow_id, version, session, saved_at) VALUES ('f2', 1, '{}', 't');
      `);

      for (const table of ["flow_versions", "nodes", "ports", "wires"]) {
        expect(
          db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?")
            .pluck()
            .get(`${table}_no_delete`),
          table,
        ).toBe(`${table}_no_delete`);
      }
      expect(() => db.exec("DELETE FROM flow_versions")).toThrow("saved flow versions are locked");
    });
  });

  describe("migrating a database made by 001 to 023 to 024", () => {
    it("leaves no build without a name", async () => {
      const before = openDatabase({ path, migrationsDir: await stage("before-024", "024") });
      before.exec(`
        INSERT INTO builds (id, hash, name, repo, base, "values", dir, created_at)
          VALUES ('b1', 'h1', NULL, '/repo', 'main', '{}', '/fd/builds/h1', 1);
        INSERT INTO runs (id, build_dir, inputs, status, created_at, build_id)
          VALUES ('r1', '/fd/builds/h1', '{}', 'done', 't', 'b1');
      `);
      before.close();

      const db = open();

      expect(db.prepare("SELECT count(*) FROM builds WHERE name IS NULL").pluck().get()).toBe(0);
    });
  });

  it("reports every migration applied on a database that did not exist before", () => {
    const { reports } = openReporting();

    expect(reports).toEqual([
      {
        applied: allMigrations.map(({ name }) => name.replace(/\.sql$/, "")),
        existedBefore: false,
      },
    ]);
  });
});
