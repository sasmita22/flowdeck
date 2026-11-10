import type Database from "better-sqlite3";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteFlowStore } from "../../../src/adapters/sqlite/flows.js";
import { openDatabase } from "../../../src/adapters/sqlite/open-database.js";
import { SqliteStore } from "../../../src/adapters/sqlite/sqlite-store.js";
import type { NewBuild, NewRun } from "../../../src/ports/store.js";
import { agent, flow, thenWire } from "../../fixtures/flow-builders.js";

const migrationsDir = fileURLToPath(
  new URL("../../../src/adapters/sqlite/migrations/", import.meta.url),
);

const twoNodes = () => flow([agent("p1"), agent("s1")], [thenWire("p1", "s1")]);

const newBuild = (overrides: Partial<NewBuild> = {}): NewBuild => ({
  id: "b1",
  hash: "h1",
  name: "fix-login",
  repo: "/repo",
  base: "main",
  values: { ticket: "FD-1", e2e: true },
  dir: "/fd/workspaces/b1",
  files: [
    { path: "plugin/commands/p1.md", sha256: "a1" },
    { path: "manifest.json", sha256: "m1" },
  ],
  nodes: [
    {
      nodeId: "p1",
      type: "prompt",
      config: { instructions: "Do it." },
      file: "plugin/commands/p1.md",
    },
    { nodeId: "s1", type: "script", config: { command: "npm" } },
  ],
  ...overrides,
});

const newRun = (overrides: Partial<NewRun> = {}): NewRun => ({
  buildDir: "/fd/workspaces/b1",
  inputs: {},
  nodeIds: ["p1", "s1"],
  session: { tmuxName: "fd-run", cwd: "/repo", claudeSessionId: "c1" },
  buildId: "b1",
  ...overrides,
});

type BuildRow = {
  id: string;
  hash?: string;
  name?: string | null;
  nodes?: string[];
  flowId?: string;
  version?: number;
};

const insertBuild = (db: Database.Database, build: BuildRow) => {
  db.transaction(() => {
    const insertNode = db.prepare(
      "INSERT INTO build_nodes (build_id, ordinal, node_id, type, config) VALUES (?, ?, ?, 'prompt', '{}')",
    );
    (build.nodes ?? ["p1", "s1"]).forEach((nodeId, ordinal) =>
      insertNode.run(build.id, ordinal, nodeId),
    );
    db.prepare(
      `INSERT INTO builds (id, hash, name, repo, base, "values", dir, created_at, flow_id, version)
       VALUES (?, ?, ?, '/repo', 'main', '{}', ?, 1, ?, ?)`,
    ).run(
      build.id,
      build.hash ?? build.id,
      build.name === undefined ? `build-${build.id}` : build.name,
      `/fd/workspaces/${build.id}`,
      build.flowId ?? null,
      build.version ?? null,
    );
  })();
};

const insertRun = (
  db: Database.Database,
  id: string,
  buildId: string | null,
  status = "running",
) => {
  db.prepare(
    "INSERT INTO runs (id, build_dir, inputs, status, created_at, build_id) VALUES (?, '/b', '{}', ?, 't', ?)",
  ).run(id, status, buildId);
};

const statusOf = (db: Database.Database, id: string) =>
  (db.prepare("SELECT status FROM runs WHERE id = ?").get(id) as { status: string }).status;

describe("build lineage", () => {
  let folder: string;
  let path: string;
  const opened: { close(): void }[] = [];

  const connect = (dir = migrationsDir) => {
    const db = openDatabase({ path, migrationsDir: dir });
    opened.push(db);
    return db;
  };

  const stores = () => {
    const db = connect();
    return {
      db,
      runs: new SqliteStore({ db, now: () => new Date("2026-03-01T00:00:00Z") }),
      flows: new SqliteFlowStore({ db, newId: () => "flow-1" }),
    };
  };

  const stage = async (name: string, before: string) => {
    const dir = join(folder, name);
    await mkdir(dir);
    for (const file of (await readdir(migrationsDir)).filter((each) => each < before)) {
      await copyFile(join(migrationsDir, file), join(dir, file));
    }
    return dir;
  };

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "fd-lineage-"));
    path = join(folder, "flowdeck.db");
  });

  afterEach(async () => {
    for (const db of opened.splice(0)) db.close();
    await rm(folder, { recursive: true, force: true });
  });

  describe("recording a build", () => {
    it("writes the build with its name, target, values and flow version, one row per file and one per node", () => {
      const { db, runs, flows } = stores();
      const source = flows.save(twoNodes());

      runs.recordBuild(newBuild({ source }));

      expect(
        db
          .prepare(
            `SELECT id, hash, name, repo, base, "values", deleted_at, dir, flow_id, version FROM builds`,
          )
          .all(),
      ).toEqual([
        {
          id: "b1",
          hash: "h1",
          name: "fix-login",
          repo: "/repo",
          base: "main",
          values: '{"ticket":"FD-1","e2e":true}',
          deleted_at: null,
          dir: "/fd/workspaces/b1",
          flow_id: "flow-1",
          version: 1,
        },
      ]);
      expect(
        db.prepare("SELECT build_id, path, sha256 FROM build_files ORDER BY path").all(),
      ).toEqual([
        { build_id: "b1", path: "manifest.json", sha256: "m1" },
        { build_id: "b1", path: "plugin/commands/p1.md", sha256: "a1" },
      ]);
      expect(
        db.prepare("SELECT build_id, node_id, type, config, file FROM build_nodes").all(),
      ).toEqual([
        {
          build_id: "b1",
          node_id: "p1",
          type: "prompt",
          config: '{"instructions":"Do it."}',
          file: "plugin/commands/p1.md",
        },
        { build_id: "b1", node_id: "s1", type: "script", config: '{"command":"npm"}', file: null },
      ]);
    });

    it("records a build made from no saved version with no flow or version", () => {
      const { db, runs } = stores();

      runs.recordBuild(newBuild());

      expect(db.prepare("SELECT flow_id, version FROM builds").all()).toEqual([
        { flow_id: null, version: null },
      ]);
    });

    it("refuses a build naming a flow version that was never saved", () => {
      const { db } = stores();

      expect(() => insertBuild(db, { id: "b1", flowId: "nope", version: 3 })).toThrow(
        /saved flow version/,
      );
    });

    it("writes nothing of a build whose node file is not one of its files", () => {
      const { db, runs } = stores();
      const broken = newBuild({
        nodes: [{ nodeId: "p1", type: "prompt", config: {}, file: "plugin/commands/missing.md" }],
      });

      expect(() => runs.recordBuild(broken)).toThrow();
      expect(db.prepare("SELECT count(*) AS n FROM builds").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM build_files").get()).toEqual({ n: 0 });
    });
  });

  describe("a recorded build is locked, except for being deleted once", () => {
    it.each([
      ["builds", "UPDATE builds SET dir = '/x'"],
      ["builds", "UPDATE builds SET name = 'other'"],
      ["builds", "UPDATE builds SET hash = 'other'"],
      ["builds", `UPDATE builds SET "values" = '{"ticket":"x"}'`],
      ["builds", "UPDATE builds SET repo = '/elsewhere', base = 'dev'"],
      ["builds", "UPDATE builds SET id = 'b9'"],
      ["builds", "UPDATE builds SET deleted_at = 1, name = 'other'"],
      ["builds", "DELETE FROM builds"],
      [
        "builds",
        `INSERT INTO builds (id, hash, name, dir, created_at) VALUES ('b1', 'h2', 'again', '/y', 0)`,
      ],
      ["build_files", "UPDATE build_files SET sha256 = 'x'"],
      ["build_files", "DELETE FROM build_files"],
      [
        "build_files",
        "INSERT INTO build_files (build_id, path, sha256) VALUES ('b1', 'extra', 'x')",
      ],
      ["build_nodes", "UPDATE build_nodes SET config = '{}'"],
      ["build_nodes", "DELETE FROM build_nodes"],
      [
        "build_nodes",
        "INSERT INTO build_nodes (build_id, ordinal, node_id, type, config) VALUES ('b1', 9, 'x', 'prompt', '{}')",
      ],
    ])("refuses a change to %s: %s", (_table, sql) => {
      const { db } = stores();
      db.transaction(() => {
        db.prepare(
          "INSERT INTO build_files (build_id, path, sha256) VALUES ('b1', 'f', 's')",
        ).run();
        insertBuild(db, { id: "b1" });
      })();

      expect(() => db.exec(sql)).toThrow(/builds are locked/);
    });

    it("lets deleted_at be set once, and refuses a second change to it", () => {
      const { db } = stores();
      insertBuild(db, { id: "b1" });

      db.exec("UPDATE builds SET deleted_at = 100 WHERE id = 'b1'");

      expect(db.prepare("SELECT deleted_at FROM builds").get()).toEqual({ deleted_at: 100 });
      expect(() => db.exec("UPDATE builds SET deleted_at = 200 WHERE id = 'b1'")).toThrow(
        /builds are locked/,
      );
      expect(() => db.exec("UPDATE builds SET deleted_at = NULL WHERE id = 'b1'")).toThrow(
        /builds are locked/,
      );
      expect(db.prepare("SELECT deleted_at FROM builds").get()).toEqual({ deleted_at: 100 });
    });

    it("lets an old build, with no name, be deleted once", () => {
      const { db } = stores();
      insertBuild(db, { id: "old", name: null, nodes: [] });

      db.exec("UPDATE builds SET deleted_at = 100 WHERE id = 'old'");

      expect(db.prepare("SELECT name, deleted_at FROM builds").get()).toEqual({
        name: null,
        deleted_at: 100,
      });
    });

    it("refuses a change to the build a run names", () => {
      const { db } = stores();
      insertBuild(db, { id: "b1" });
      insertBuild(db, { id: "b2" });
      insertRun(db, "r1", "b1");

      expect(() => db.exec("UPDATE runs SET build_dir = '/x' WHERE id = 'r1'")).toThrow(/locked/);
      expect(() => db.exec("UPDATE runs SET build_id = 'b2' WHERE id = 'r1'")).toThrow(/locked/);
      expect(() => db.exec("UPDATE runs SET build_id = NULL WHERE id = 'r1'")).toThrow(/locked/);
    });
  });

  describe("build names", () => {
    it("refuses a second build with the name of one not deleted", () => {
      const { db } = stores();
      insertBuild(db, { id: "b1", name: "fix-login" });

      expect(() => insertBuild(db, { id: "b2", name: "fix-login" })).toThrow(/UNIQUE/);
    });

    it("lets a deleted build's name be used again", () => {
      const { db } = stores();
      insertBuild(db, { id: "b1", name: "fix-login" });
      db.exec("UPDATE builds SET deleted_at = 100 WHERE id = 'b1'");

      insertBuild(db, { id: "b2", name: "fix-login" });

      expect(
        db.prepare("SELECT id FROM builds WHERE name = 'fix-login' ORDER BY id").all(),
      ).toEqual([{ id: "b1" }, { id: "b2" }]);
    });

    it("lets one hash be recorded under two ids and names", () => {
      const { db } = stores();
      insertBuild(db, { id: "b1", hash: "h1", name: "fix-login" });

      insertBuild(db, { id: "b2", hash: "h1", name: "fix-signup" });

      expect(db.prepare("SELECT id, hash FROM builds ORDER BY id").all()).toEqual([
        { id: "b1", hash: "h1" },
        { id: "b2", hash: "h1" },
      ]);
    });
  });

  describe("runs", () => {
    it("refuses to replace a run with INSERT OR REPLACE", () => {
      const { db } = stores();
      insertBuild(db, { id: "b1" });
      insertRun(db, "r1", "b1", "done");

      expect(() =>
        db
          .prepare(
            "INSERT OR REPLACE INTO runs (id, build_dir, inputs, status, created_at, build_id) VALUES ('r1', '/z', '{}', 'done', 't', 'b1')",
          )
          .run(),
      ).toThrow(/a run is never replaced/);
      expect(db.prepare("SELECT build_dir FROM runs").get()).toEqual({ build_dir: "/b" });
    });

    it("refuses a new run that names no build", () => {
      const { db } = stores();

      expect(() => insertRun(db, "r1", null)).toThrow(/names the build it runs/);
    });

    it("refuses a new run that names a build never recorded", () => {
      const { db } = stores();

      expect(() => insertRun(db, "r1", "ghost", "done")).toThrow(/FOREIGN KEY/);
    });

    it("refuses a run node that is not a node of its build", () => {
      const { db } = stores();
      insertBuild(db, { id: "b1", nodes: ["p1"] });
      insertRun(db, "r1", "b1");
      db.prepare(
        "INSERT INTO run_sessions (id, run_id, tmux_name, cwd, claude_session_id, status) VALUES (1, 'r1', 'fd-a', '/repo', 'c1', 'open')",
      ).run();

      db.prepare(
        "INSERT INTO run_nodes (run_id, node_id, session_id) VALUES ('r1', 'p1', 1)",
      ).run();
      expect(() =>
        db
          .prepare("INSERT INTO run_nodes (run_id, node_id, session_id) VALUES ('r1', 'ghost', 1)")
          .run(),
      ).toThrow(/node of its build/);
    });

    it("lets a run of a build with no node rows have any node", () => {
      const { db } = stores();
      insertBuild(db, { id: "old", name: null, nodes: [] });
      insertRun(db, "r1", "old");
      db.prepare(
        "INSERT INTO run_sessions (id, run_id, tmux_name, cwd, claude_session_id, status) VALUES (1, 'r1', 'fd-a', '/repo', 'c1', 'open')",
      ).run();

      db.prepare(
        "INSERT INTO run_nodes (run_id, node_id, session_id) VALUES ('r1', 'anything', 1)",
      ).run();

      expect(db.prepare("SELECT node_id FROM run_nodes").all()).toEqual([{ node_id: "anything" }]);
    });

    it("joins a run to its build, flow and version by the build id", () => {
      const { db, flows } = stores();
      flows.save(twoNodes());
      flows.save(twoNodes());
      insertBuild(db, { id: "b1", hash: "h1", flowId: "flow-1", version: 2 });
      insertRun(db, "r1", "b1");
      db.prepare(
        "INSERT INTO run_sessions (id, run_id, tmux_name, cwd, claude_session_id, status) VALUES (1, 'r1', 'fd-a', '/repo', 'c1', 'open')",
      ).run();
      db.prepare(
        "INSERT INTO run_nodes (run_id, node_id, session_id) VALUES ('r1', 's1', 1)",
      ).run();

      const row = db
        .prepare(
          `SELECT runs.id, builds.id AS build, builds.hash, flows.id AS flow, flow_versions.version, build_nodes.node_id
             FROM runs
             JOIN builds ON builds.id = runs.build_id
             JOIN flow_versions ON flow_versions.flow_id = builds.flow_id
                               AND flow_versions.version = builds.version
             JOIN flows ON flows.id = flow_versions.flow_id
             JOIN run_nodes ON run_nodes.run_id = runs.id
             JOIN build_nodes ON build_nodes.build_id = runs.build_id
                             AND build_nodes.node_id = run_nodes.node_id
            WHERE runs.id = 'r1'`,
        )
        .get();

      expect(row).toEqual({
        id: "r1",
        build: "b1",
        hash: "h1",
        flow: "flow-1",
        version: 2,
        node_id: "s1",
      });
    });

    it("writes a run's total cost", () => {
      const { db, runs } = stores();
      runs.recordBuild(newBuild());
      const { id } = runs.createRun(newRun());

      runs.recordCost(id, 0.125);

      expect(db.prepare("SELECT total_cost FROM runs").get()).toEqual({ total_cost: 0.125 });
    });
  });

  describe("one running run per build", () => {
    it("refuses a second running run of a build", () => {
      const { db } = stores();
      insertBuild(db, { id: "b1" });
      insertRun(db, "r1", "b1");

      expect(() => insertRun(db, "r2", "b1")).toThrow(/build is running/);
      expect(db.prepare("SELECT id FROM runs").all()).toEqual([{ id: "r1" }]);
    });

    it("lets another build run, and a finished run of the running build be written", () => {
      const { db } = stores();
      insertBuild(db, { id: "b1" });
      insertBuild(db, { id: "b2" });
      insertRun(db, "r1", "b1");

      insertRun(db, "r2", "b2");
      insertRun(db, "r3", "b1", "done");

      expect(db.prepare("SELECT id, status FROM runs ORDER BY id").all()).toEqual([
        { id: "r1", status: "running" },
        { id: "r2", status: "running" },
        { id: "r3", status: "done" },
      ]);
    });

    it("refuses to set a run running again while another run of its build is running", () => {
      const { db } = stores();
      insertBuild(db, { id: "b1" });
      insertRun(db, "r1", "b1", "stopped");
      insertRun(db, "r2", "b1");

      expect(() => db.exec("UPDATE runs SET status = 'running' WHERE id = 'r1'")).toThrow(
        /build is running/,
      );
      expect(statusOf(db, "r1")).toBe("stopped");
    });

    it("lets a run be set running again once the other run of its build has finished", () => {
      const { db } = stores();
      insertBuild(db, { id: "b1" });
      insertRun(db, "r1", "b1", "stopped");
      insertRun(db, "r2", "b1");
      db.exec("UPDATE runs SET status = 'done' WHERE id = 'r2'");

      db.exec("UPDATE runs SET status = 'running' WHERE id = 'r1'");

      expect(statusOf(db, "r1")).toBe("running");
    });

    describe("in a database that already held two running runs of one build", () => {
      const seedTwoRunning = async () => {
        const db = openDatabase({ path, migrationsDir: await stage("to-007", "008") });
        db.exec(`
          INSERT INTO builds (hash, dir, created_at) VALUES ('h1', '/fd/builds/h1', 1);
          INSERT INTO runs (id, build_dir, inputs, status, created_at, build_hash)
            VALUES ('r-a', '/fd/builds/h1', '{}', 'running', 't1', 'h1'),
                   ('r-b', '/fd/builds/h1', '{}', 'running', 't2', 'h1');
        `);
        db.close();
        return connect();
      };

      it("keeps both running after the migration", async () => {
        const db = await seedTwoRunning();

        expect(db.prepare("SELECT id, status, build_id FROM runs ORDER BY id").all()).toEqual([
          { id: "r-a", status: "running", build_id: "h1" },
          { id: "r-b", status: "running", build_id: "h1" },
        ]);
      });

      it("still writes their cost and how they finished", async () => {
        const db = await seedTwoRunning();

        db.exec("UPDATE runs SET total_cost = 0.5 WHERE id = 'r-a'");
        db.exec("UPDATE runs SET status = 'stopped' WHERE id = 'r-a'");

        expect(db.prepare("SELECT status, total_cost FROM runs WHERE id = 'r-a'").get()).toEqual({
          status: "stopped",
          total_cost: 0.5,
        });
      });

      it("refuses to set the finished one running while the other still runs", async () => {
        const db = await seedTwoRunning();
        db.exec("UPDATE runs SET status = 'stopped' WHERE id = 'r-a'");

        expect(() => db.exec("UPDATE runs SET status = 'running' WHERE id = 'r-a'")).toThrow(
          /build is running/,
        );
      });
    });
  });

  describe("runs of a deleted build", () => {
    it("refuses a new run of a deleted build, and keeps the build's earlier runs", () => {
      const { db } = stores();
      insertBuild(db, { id: "b1" });
      insertRun(db, "r1", "b1", "done");
      db.exec("UPDATE builds SET deleted_at = 100 WHERE id = 'b1'");

      expect(() => insertRun(db, "r2", "b1")).toThrow(/build is deleted/);
      expect(() => insertRun(db, "r3", "b1", "done")).toThrow(/build is deleted/);
      expect(db.prepare("SELECT id FROM runs").all()).toEqual([{ id: "r1" }]);
    });

    it("lets a live build run while another build is deleted", () => {
      const { db } = stores();
      insertBuild(db, { id: "b1" });
      insertBuild(db, { id: "b2", name: "other" });
      db.exec("UPDATE builds SET deleted_at = 100 WHERE id = 'b1'");

      insertRun(db, "r1", "b2");

      expect(db.prepare("SELECT id FROM runs").all()).toEqual([{ id: "r1" }]);
    });
  });

  describe("reading builds", () => {
    it("lists builds newest first, each with its name, flow version, time, hash and id", () => {
      const db = connect();
      let time = Date.parse("2026-03-01T00:00:00Z");
      const runs = new SqliteStore({ db, now: () => new Date((time += 1000)) });
      const source = new SqliteFlowStore({ db, newId: () => "flow-1" }).save(twoNodes());
      runs.recordBuild(newBuild({ source }));
      runs.recordBuild(
        newBuild({ id: "b2", name: "fix-signup", dir: "/fd/workspaces/b2", files: [], nodes: [] }),
      );

      expect(runs.listBuilds()).toEqual([
        expect.objectContaining({
          id: "b2",
          hash: "h1",
          name: "fix-signup",
          dir: "/fd/workspaces/b2",
          createdAt: Date.parse("2026-03-01T00:00:02Z"),
        }),
        expect.objectContaining({
          id: "b1",
          hash: "h1",
          name: "fix-login",
          repo: "/repo",
          base: "main",
          values: { ticket: "FD-1", e2e: true },
          dir: "/fd/workspaces/b1",
          createdAt: Date.parse("2026-03-01T00:00:01Z"),
          source: { flowId: "flow-1", version: 1 },
        }),
      ]);
      expect(runs.findBuild("b1")).toEqual(runs.listBuilds()[1]);
      expect(runs.findBuild("nope")).toBeUndefined();
    });

    it("reads a build's files in path order, by its id", () => {
      const { runs } = stores();
      runs.recordBuild(newBuild());

      expect(runs.buildFiles("b1")).toEqual([
        { path: "manifest.json", sha256: "m1" },
        { path: "plugin/commands/p1.md", sha256: "a1" },
      ]);
      expect(runs.buildFiles("h1")).toEqual([]);
    });
  });

  describe("migrating a database made before builds had lineage", () => {
    const seedOldDatabase = async () => {
      const db = connect(await stage("to-005", "006"));
      new SqliteFlowStore({ db, newId: () => "flow-1" }).save(twoNodes());
      db.exec(`
        INSERT INTO builds (hash, dir, created_at) VALUES ('old', '/fd/builds/old', 5);
        INSERT INTO runs (id, build_dir, inputs, status, created_at, build_hash)
          VALUES ('r1', '/fd/builds/old', '{}', 'done', 't1', 'old'),
                 ('r2', '/fd/builds/old', '{"a":1}', 'running', 't2', NULL);
        INSERT INTO run_sessions (id, run_id, tmux_name, cwd, claude_session_id, status)
          VALUES (1, 'r1', 'fd-a', '/repo', 'c1', 'closed'), (2, 'r2', 'fd-b', '/repo', 'c2', 'open');
        INSERT INTO run_nodes (run_id, node_id, session_id) VALUES ('r1', 'p1', 1), ('r2', 'p1', 2);
        INSERT INTO events (run_id, node_id, kind, time) VALUES ('r1', 'p1', 'sent', 't'), ('r1', 'p1', 'done', 't');
      `);
      const tables = [
        "flows",
        "flow_versions",
        "nodes",
        "wires",
        "builds",
        "runs",
        "run_sessions",
        "run_nodes",
        "events",
      ];
      const before = Object.fromEntries(
        tables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]),
      ) as Record<string, Record<string, unknown>[]>;
      db.close();
      return { tables, before };
    };

    it("keeps every old row, the old build with its hash as id and nothing else new, the old run with no build", async () => {
      const { tables, before } = await seedOldDatabase();

      const db = connect();

      for (const table of tables) {
        const after = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
        const expected = (before[table] ?? []).map((row) => {
          if (table === "builds") {
            return {
              ...row,
              id: row["hash"],
              name: null,
              repo: null,
              base: null,
              values: null,
              deleted_at: null,
              flow_id: null,
              version: null,
            };
          }
          if (table === "runs") {
            const { build_hash, ...rest } = row;
            return { ...rest, build_id: build_hash };
          }
          if (table === "flows") return { ...row, pinned: 0 };
          return row;
        });
        expect(after, table).toEqual(expected);
      }
    });

    it("still reads the old run, and locks the old build", async () => {
      await seedOldDatabase();
      const db = connect();
      const runs = new SqliteStore({ db });

      expect(runs.findRun("r2")).toMatchObject({ id: "r2", status: "running" });
      expect(runs.findRun("r2")).not.toHaveProperty("buildId");
      expect(runs.findBuild("old")).toMatchObject({
        id: "old",
        hash: "old",
        name: null,
        dir: "/fd/builds/old",
        createdAt: 5,
      });
      expect(() => db.exec("DELETE FROM builds")).toThrow(/builds are locked/);
    });

    it("runs a new run of the old build, which has no node rows", async () => {
      await seedOldDatabase();
      const runs = new SqliteStore({ db: connect() });

      const run = runs.createRun(newRun({ buildId: "old", buildDir: "/fd/builds/old" }));

      expect(runs.findRun(run.id)?.buildId).toBe("old");
    });
  });
});
