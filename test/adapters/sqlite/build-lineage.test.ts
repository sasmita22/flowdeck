import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteFlowStore } from "../../../src/adapters/sqlite/flows.js";
import { openDatabase } from "../../../src/adapters/sqlite/open-database.js";
import { SqliteStore } from "../../../src/adapters/sqlite/sqlite-store.js";
import type { NewBuild, NewRun } from "../../../src/ports/store.js";
import { flow, prompt, script, thenWire } from "../../fixtures/flow-builders.js";

const migrationsDir = fileURLToPath(
  new URL("../../../src/adapters/sqlite/migrations/", import.meta.url),
);

const twoNodes = () => flow([prompt("p1"), script("s1")], [thenWire("p1", "s1")]);

const newBuild = (overrides: Partial<NewBuild> = {}): NewBuild => ({
  hash: "h1",
  dir: "/fd/builds/h1",
  files: [
    { path: "commands/p1.md", sha256: "a1" },
    { path: "manifest.json", sha256: "m1" },
  ],
  nodes: [
    { nodeId: "p1", type: "prompt", config: { instructions: "Do it." }, file: "commands/p1.md" },
    { nodeId: "s1", type: "script", config: { command: "npm" } },
  ],
  ...overrides,
});

const newRun = (overrides: Partial<NewRun> = {}): NewRun => ({
  buildDir: "/fd/builds/h1",
  inputs: {},
  nodeIds: ["p1", "s1"],
  session: { tmuxName: "fd-run", cwd: "/repo", claudeSessionId: "c1" },
  buildHash: "h1",
  ...overrides,
});

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

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "fd-lineage-"));
    path = join(folder, "flowdeck.db");
  });

  afterEach(async () => {
    for (const db of opened.splice(0)) db.close();
    await rm(folder, { recursive: true, force: true });
  });

  describe("recording a build", () => {
    it("writes the build with its flow version, one row per file and one per node", () => {
      const { db, runs, flows } = stores();
      const source = flows.save(twoNodes());

      runs.recordBuild(newBuild({ source }));

      expect(db.prepare("SELECT hash, dir, flow_id, version FROM builds").all()).toEqual([
        { hash: "h1", dir: "/fd/builds/h1", flow_id: "flow-1", version: 1 },
      ]);
      expect(
        db.prepare("SELECT build_hash, path, sha256 FROM build_files ORDER BY path").all(),
      ).toEqual([
        { build_hash: "h1", path: "commands/p1.md", sha256: "a1" },
        { build_hash: "h1", path: "manifest.json", sha256: "m1" },
      ]);
      expect(
        db.prepare("SELECT build_hash, node_id, type, config, file FROM build_nodes").all(),
      ).toEqual([
        {
          build_hash: "h1",
          node_id: "p1",
          type: "prompt",
          config: '{"instructions":"Do it."}',
          file: "commands/p1.md",
        },
        {
          build_hash: "h1",
          node_id: "s1",
          type: "script",
          config: '{"command":"npm"}',
          file: null,
        },
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
      const { runs } = stores();

      expect(() => runs.recordBuild(newBuild({ source: { flowId: "nope", version: 3 } }))).toThrow(
        /saved flow version/,
      );
    });

    it("keeps the first record of a hash and ignores a second", () => {
      const { db, runs } = stores();
      runs.recordBuild(newBuild());

      runs.recordBuild(newBuild({ dir: "/elsewhere", files: [], nodes: [] }));

      expect(db.prepare("SELECT dir FROM builds").all()).toEqual([{ dir: "/fd/builds/h1" }]);
      expect(db.prepare("SELECT count(*) AS n FROM build_files").get()).toEqual({ n: 2 });
    });

    it("writes nothing of a build whose node file is not one of its files", () => {
      const { db, runs } = stores();
      const broken = newBuild({
        nodes: [{ nodeId: "p1", type: "prompt", config: {}, file: "commands/missing.md" }],
      });

      expect(() => runs.recordBuild(broken)).toThrow();
      expect(db.prepare("SELECT count(*) AS n FROM builds").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM build_files").get()).toEqual({ n: 0 });
    });
  });

  describe("a recorded build is locked", () => {
    it.each([
      ["builds", "UPDATE builds SET dir = '/x'"],
      ["builds", "DELETE FROM builds"],
      ["builds", "INSERT INTO builds (hash, dir, created_at) VALUES ('h1', '/y', 0)"],
      ["build_files", "UPDATE build_files SET sha256 = 'x'"],
      ["build_files", "DELETE FROM build_files"],
      [
        "build_files",
        "INSERT INTO build_files (build_hash, path, sha256) VALUES ('h1', 'extra', 'x')",
      ],
      ["build_nodes", "UPDATE build_nodes SET config = '{}'"],
      ["build_nodes", "DELETE FROM build_nodes"],
      [
        "build_nodes",
        "INSERT INTO build_nodes (build_hash, ordinal, node_id, type, config) VALUES ('h1', 9, 'x', 'prompt', '{}')",
      ],
    ])("refuses a change to %s: %s", (_table, sql) => {
      const { db, runs } = stores();
      runs.recordBuild(newBuild());

      expect(() => db.exec(sql)).toThrow(/builds are locked/);
    });

    it("refuses a change to the build a run names", () => {
      const { db, runs } = stores();
      runs.recordBuild(newBuild());
      const { id } = runs.createRun(newRun());

      expect(() => db.prepare("UPDATE runs SET build_dir = '/x' WHERE id = ?").run(id)).toThrow(
        /locked/,
      );
      expect(() => db.prepare("UPDATE runs SET build_hash = NULL WHERE id = ?").run(id)).toThrow(
        /locked/,
      );
    });
  });

  describe("runs", () => {
    it("refuses to replace a run with INSERT OR REPLACE", () => {
      const { db, runs } = stores();
      runs.recordBuild(newBuild());
      const { id } = runs.createRun(newRun());

      expect(() =>
        db
          .prepare(
            "INSERT OR REPLACE INTO runs (id, build_dir, inputs, status, created_at, build_hash) VALUES (?, '/z', '{}', 'running', 't', 'h1')",
          )
          .run(id),
      ).toThrow(/a run is never replaced/);
      expect(runs.findRun(id)?.buildDir).toBe("/fd/builds/h1");
    });

    it("refuses a new run that names no build", () => {
      const { db } = stores();

      expect(() =>
        db
          .prepare(
            "INSERT INTO runs (id, build_dir, inputs, status, created_at) VALUES ('r', '/b', '{}', 'running', 't')",
          )
          .run(),
      ).toThrow(/names the build it runs/);
    });

    it("refuses a run node that is not a node of its build", () => {
      const { runs } = stores();
      runs.recordBuild(newBuild());

      expect(() => runs.createRun(newRun({ nodeIds: ["p1", "ghost"] }))).toThrow(
        /node of its build/,
      );
    });

    it("joins a run to its build, flow and version", () => {
      const { db, runs, flows } = stores();
      flows.save(twoNodes());
      const source = flows.save(twoNodes());
      runs.recordBuild(newBuild({ source }));
      const { id } = runs.createRun(newRun());

      const row = db
        .prepare(
          `SELECT runs.id, builds.hash, flows.id AS flow, flow_versions.version, build_nodes.type
             FROM runs
             JOIN builds ON builds.hash = runs.build_hash
             JOIN flow_versions ON flow_versions.flow_id = builds.flow_id
                               AND flow_versions.version = builds.version
             JOIN flows ON flows.id = flow_versions.flow_id
             JOIN run_nodes ON run_nodes.run_id = runs.id
             JOIN build_nodes ON build_nodes.build_hash = runs.build_hash
                             AND build_nodes.node_id = run_nodes.node_id
            WHERE runs.id = ? AND run_nodes.node_id = 's1'`,
        )
        .get(id);

      expect(row).toEqual({ id, hash: "h1", flow: "flow-1", version: 2, type: "script" });
    });

    it("writes a run's total cost", () => {
      const { db, runs } = stores();
      runs.recordBuild(newBuild());
      const { id } = runs.createRun(newRun());

      runs.recordCost(id, 0.125);

      expect(db.prepare("SELECT total_cost FROM runs").get()).toEqual({ total_cost: 0.125 });
    });
  });

  describe("reading builds", () => {
    it("lists builds newest first, each with its flow version, time and hash", () => {
      const db = connect();
      let time = Date.parse("2026-03-01T00:00:00Z");
      const runs = new SqliteStore({ db, now: () => new Date((time += 1000)) });
      const source = new SqliteFlowStore({ db, newId: () => "flow-1" }).save(twoNodes());
      runs.recordBuild(newBuild({ source }));
      runs.recordBuild(newBuild({ hash: "h2", dir: "/fd/builds/h2", files: [], nodes: [] }));

      expect(runs.listBuilds()).toEqual([
        { hash: "h2", dir: "/fd/builds/h2", createdAt: Date.parse("2026-03-01T00:00:02Z") },
        {
          hash: "h1",
          dir: "/fd/builds/h1",
          createdAt: Date.parse("2026-03-01T00:00:01Z"),
          source: { flowId: "flow-1", version: 1 },
        },
      ]);
      expect(runs.findBuild("h1")).toEqual(runs.listBuilds()[1]);
      expect(runs.findBuild("nope")).toBeUndefined();
    });

    it("reads a build's files in path order", () => {
      const { runs } = stores();
      runs.recordBuild(newBuild());

      expect(runs.buildFiles("h1")).toEqual([
        { path: "commands/p1.md", sha256: "a1" },
        { path: "manifest.json", sha256: "m1" },
      ]);
      expect(runs.buildFiles("nope")).toEqual([]);
    });
  });

  describe("migrating a database made before builds had lineage", () => {
    const seedOldDatabase = async () => {
      const oldDir = join(folder, "old-migrations");
      await mkdir(oldDir);
      for (const name of (await readdir(migrationsDir)).filter((file) => file < "006")) {
        await copyFile(join(migrationsDir, name), join(oldDir, name));
      }
      const db = connect(oldDir);
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
      );
      db.close();
      return { tables, before };
    };

    it("keeps every old row, with no lineage on the old build and no build on the old run", async () => {
      const { tables, before } = await seedOldDatabase();

      const db = connect();

      for (const table of tables) {
        const after = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
        const kept = after.map((row) => {
          const copy = { ...row };
          if (table === "builds") {
            expect(copy).toMatchObject({ flow_id: null, version: null });
            delete copy["flow_id"];
            delete copy["version"];
          }
          return copy;
        });
        expect(kept, table).toEqual(before[table]);
      }
      expect(db.prepare("SELECT name FROM migrations WHERE name LIKE '006%'").all()).toEqual([
        { name: "006_build_lineage.sql" },
      ]);
    });

    it("still reads the old run, and locks the old build", async () => {
      await seedOldDatabase();
      const db = connect();
      const runs = new SqliteStore({ db });

      expect(runs.findRun("r2")).toMatchObject({ id: "r2", status: "running" });
      expect(runs.findRun("r2")).not.toHaveProperty("buildHash");
      expect(runs.findBuild("old")).toEqual({ hash: "old", dir: "/fd/builds/old", createdAt: 5 });
      expect(() => db.exec("DELETE FROM builds")).toThrow(/builds are locked/);
    });

    it("runs a new run of the old build, which has no node rows", async () => {
      await seedOldDatabase();
      const runs = new SqliteStore({ db: connect() });

      const run = runs.createRun(newRun({ buildHash: "old", buildDir: "/fd/builds/old" }));

      expect(runs.findRun(run.id)?.buildHash).toBe("old");
    });
  });
});
