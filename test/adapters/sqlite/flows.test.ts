import Database from "better-sqlite3";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteFlowStore } from "../../../src/adapters/sqlite/flows.js";
import { openDatabase } from "../../../src/adapters/sqlite/open-database.js";
import { SqliteStore } from "../../../src/adapters/sqlite/sqlite-store.js";
import { flowsEqual } from "../../../src/core/flow/equal.js";
import type { CanvasNote, Flow } from "../../../src/core/flow/schema.js";
import { registry } from "../../../src/core/nodes/registry.js";
import { roundTripFlow } from "../../fixtures/round-trip-flow.js";

const notes: CanvasNote[] = [
  {
    id: "n1",
    text: "Plan first,\nthen build",
    position: { x: -40, y: 12.5 },
    size: { width: 220, height: 140 },
  },
  { id: "n2", text: "", position: { x: 300, y: 0 }, size: { width: 160, height: 80 } },
];

const withNotes = (): Flow => ({ ...roundTripFlow(), notes });

const migrationsDir = new URL("../../../src/adapters/sqlite/migrations/", import.meta.url);

const relabelled = (label: string): Flow => {
  const flow = roundTripFlow();
  return { ...flow, nodes: flow.nodes.map((node, i) => (i === 0 ? { ...node, label } : node)) };
};

describe("SqliteFlowStore", () => {
  let folder: string;
  let path: string;
  const opened: { close(): void }[] = [];

  const connect = () => {
    const db = openDatabase({ path });
    opened.push(db);
    return db;
  };

  const open = (newId: () => string = () => "flow-1") =>
    new SqliteFlowStore({ db: connect(), newId });

  const raw = () => {
    const db = new Database(path);
    opened.push(db);
    return db;
  };

  const count = (db: Database.Database, table: string) =>
    (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "fd-flows-"));
    path = join(folder, "flowdeck.db");
  });

  afterEach(async () => {
    for (const db of opened.splice(0)) db.close();
    await rm(folder, { recursive: true, force: true });
  });

  it("loads nothing from a fresh database", () => {
    expect(open().loadLatest()).toBeNull();
  });

  describe("round trip", () => {
    it("reopens a saved flow with every type, parent, optional field and event wire exactly", () => {
      open().save(roundTripFlow());

      const loaded = open().loadLatest();

      expect(loaded?.flow).toEqual(roundTripFlow());
      expect(flowsEqual(loaded?.flow ?? roundTripFlow(), roundTripFlow())).toBe(true);
    });

    it("leaves absent optionals absent rather than null", () => {
      const original = roundTripFlow();
      open().save(original);

      const flow = open().loadLatest()?.flow;

      const withoutParent = original.nodes.filter((node) => node.parent === undefined);
      expect(withoutParent.length).toBeGreaterThan(0);
      for (const node of withoutParent) {
        const reloaded = flow?.nodes.find((candidate) => candidate.id === node.id);
        expect(reloaded).toBeDefined();
        expect(Object.hasOwn(reloaded ?? {}, "parent")).toBe(false);
      }
      const eventWire = flow?.wires.find((wire) => wire.kind === "event");
      expect(eventWire).toBeDefined();
      expect(Object.hasOwn(eventWire ?? {}, "file")).toBe(false);
    });

    it("reopens a flow's notes exactly, in order", () => {
      open().save(withNotes());

      expect(open().loadLatest()?.flow).toEqual(withNotes());
    });

    it("reopens a flow saved without notes with no notes key", () => {
      open().save(roundTripFlow());

      expect(open().loadLatest()?.flow).not.toHaveProperty("notes");
    });

    it("reopens a flow saved with an empty notes list with no notes key", () => {
      open().save({ ...roundTripFlow(), notes: [] });

      expect(open().loadLatest()?.flow).toEqual(roundTripFlow());
    });

    it("keeps each version's own notes", () => {
      const store = open();
      store.save(withNotes());
      store.save(roundTripFlow());

      expect(open().loadLatest()?.flow).not.toHaveProperty("notes");
      expect(
        raw()
          .prepare("SELECT version, notes FROM flow_versions ORDER BY version")
          .all()
          .map((row) => {
            const { version, notes: stored } = row as { version: number; notes: string };
            return { version, notes: JSON.parse(stored) as unknown };
          }),
      ).toEqual([
        { version: 1, notes },
        { version: 2, notes: [] },
      ]);
    });

    it("loads a version saved before notes existed with no notes", async () => {
      const before = join(folder, "migrations-before-notes");
      await mkdir(before);
      for (const name of await readdir(migrationsDir)) {
        if (name < "005") await copyFile(new URL(name, migrationsDir), join(before, name));
      }
      const old = openDatabase({ path, migrationsDir: before });
      opened.push(old);
      const session = roundTripFlow().session;
      old
        .prepare("INSERT INTO flows (id, name, created_at) VALUES ('flow-1', 'Untitled', 't')")
        .run();
      old
        .prepare(
          "INSERT INTO flow_versions (flow_id, version, session, saved_at) VALUES ('flow-1', 1, ?, 't')",
        )
        .run(JSON.stringify(session));

      const loaded = open().loadLatest();

      expect(loaded?.version).toBe(1);
      expect(loaded?.flow).toEqual({ nodes: [], wires: [], session });
    });

    it("keeps node order and wire order", () => {
      const original = roundTripFlow();
      open().save(original);

      const flow = open().loadLatest()?.flow;

      expect(flow?.nodes.map((node) => node.id)).toEqual(original.nodes.map((node) => node.id));
      expect(flow?.wires).toEqual(original.wires);
    });
  });

  it("writes each wire as plain rows: kind, node id and port name of each end, and no file", () => {
    const flow = roundTripFlow();
    open().save(flow);

    const rows = raw()
      .prepare(
        "SELECT ordinal, kind, from_node, from_port, to_node, to_port, file FROM wires ORDER BY ordinal",
      )
      .all();

    expect(rows).toEqual(
      flow.wires.map((wire, ordinal) => ({
        ordinal,
        kind: wire.kind,
        from_node: wire.from.node,
        from_port: wire.from.port,
        to_node: wire.to.node,
        to_port: wire.to.port,
        file: null,
      })),
    );
  });

  it("snapshots each node's registry ports in order", () => {
    const flow = roundTripFlow();
    open().save(flow);
    const db = raw();
    const portsOf = db.prepare(
      "SELECT name, direction, kind FROM ports WHERE node_id = ? ORDER BY ordinal",
    );

    for (const node of flow.nodes) {
      expect(portsOf.all(node.id)).toEqual(
        registry[node.type].ports.map(({ name, direction, kind }) => ({ name, direction, kind })),
      );
    }
    expect(count(db, "ports")).toBe(
      flow.nodes.reduce((total, node) => total + registry[node.type].ports.length, 0),
    );
  });

  describe("versions", () => {
    it("saves versions 1, 2 and 3 of one flow named Untitled with the injected id", () => {
      const store = open();

      const refs = [
        store.save(relabelled("a")),
        store.save(relabelled("b")),
        store.save(relabelled("c")),
      ];

      expect(refs).toEqual([
        { flowId: "flow-1", version: 1 },
        { flowId: "flow-1", version: 2 },
        { flowId: "flow-1", version: 3 },
      ]);
      expect(raw().prepare("SELECT id, name FROM flows").all()).toEqual([
        { id: "flow-1", name: "Untitled" },
      ]);
    });

    it("continues the same flow after a relaunch on a new connection", () => {
      const store = open();
      store.save(relabelled("a"));
      store.save(relabelled("b"));
      store.save(relabelled("c"));

      const relaunched = open(() => "flow-2");
      const ref = relaunched.save(relabelled("d"));

      expect(ref).toEqual({ flowId: "flow-1", version: 4 });
      expect(raw().prepare("SELECT id FROM flows").all()).toEqual([{ id: "flow-1" }]);
      expect(open(() => "flow-3").loadLatest()).toEqual({
        flowId: "flow-1",
        name: "Untitled",
        version: 4,
        flow: relabelled("d"),
      });
    });
  });

  it("loads a chosen saved version, and nothing for a version or flow never saved", () => {
    const store = open();
    store.save(relabelled("a"));
    store.save(relabelled("b"));

    expect(open(() => "flow-2").load({ flowId: "flow-1", version: 1 })).toEqual({
      flowId: "flow-1",
      name: "Untitled",
      version: 1,
      flow: relabelled("a"),
    });
    expect(store.load({ flowId: "flow-1", version: 3 })).toBeNull();
    expect(store.load({ flowId: "nope", version: 1 })).toBeNull();
  });

  it("reopens a saved flow with no nodes or wires as the latest version", () => {
    const store = open();
    store.save(relabelled("a"));
    const emptied: Flow = { ...roundTripFlow(), nodes: [], wires: [] };

    store.save(emptied);

    expect(open().loadLatest()).toEqual({
      flowId: "flow-1",
      name: "Untitled",
      version: 2,
      flow: emptied,
    });
  });

  it("stamps the flow's creation and each version's save time from the injected clock", () => {
    const times = ["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"];
    let tick = 0;
    const store = new SqliteFlowStore({
      db: connect(),
      newId: () => "flow-1",
      now: () => new Date(times[tick++] ?? "2026-12-31T00:00:00.000Z"),
    });

    store.save(relabelled("a"));
    store.save(relabelled("b"));

    const db = raw();
    expect(db.prepare("SELECT created_at FROM flows").all()).toEqual([{ created_at: times[0] }]);
    expect(
      db.prepare("SELECT version, saved_at FROM flow_versions ORDER BY version").all(),
    ).toEqual([
      { version: 1, saved_at: times[0] },
      { version: 2, saved_at: times[1] },
    ]);
  });

  it("writes nothing of a save whose wires cannot be written, and keeps the version before it", () => {
    const store = open();
    const first = relabelled("first");
    store.save(first);
    const db = raw();
    db.exec("CREATE TRIGGER boom BEFORE INSERT ON wires BEGIN SELECT RAISE(ABORT, 'boom'); END");
    const second = relabelled("second");
    expect(second.wires.length).toBeGreaterThan(0);

    expect(() => store.save(second)).toThrow("boom");

    expect(db.prepare("SELECT version FROM flow_versions").all()).toEqual([{ version: 1 }]);
    expect(db.prepare("SELECT DISTINCT version FROM nodes").all()).toEqual([{ version: 1 }]);
    expect(db.prepare("SELECT DISTINCT version FROM ports").all()).toEqual([{ version: 1 }]);
    expect(db.prepare("SELECT DISTINCT version FROM wires").all()).toEqual([{ version: 1 }]);
    expect(store.loadLatest()).toMatchObject({ version: 1, flow: first });
  });

  describe("locks saved versions in the database itself", () => {
    const lockedTables = [
      ["flow_versions", "session = '{}'"],
      ["flow_versions", "notes = '[]'"],
      ["nodes", "label = 'changed'"],
      ["ports", "name = 'changed'"],
      ["wires", "to_port = 'changed'"],
    ] as const;

    const savedThree = () => {
      const store = open();
      store.save(relabelled("a"));
      store.save(relabelled("b"));
      store.save(relabelled("c"));
      return raw();
    };

    it.each(lockedTables)("rejects an UPDATE on a version 3 row of %s", (table, assignment) => {
      const db = savedThree();
      const rows = () => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      const before = rows();

      expect(() => db.exec(`UPDATE ${table} SET ${assignment} WHERE version = 3`)).toThrow(
        "saved flow versions are locked",
      );
      expect(rows()).toEqual(before);
    });

    it.each(lockedTables)("rejects a DELETE on a version 3 row of %s", (table) => {
      const db = savedThree();
      const rows = () => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      const before = rows();

      expect(() => db.exec(`DELETE FROM ${table} WHERE version = 3`)).toThrow(
        "saved flow versions are locked",
      );
      expect(rows()).toEqual(before);
    });

    it.each([
      ["flow_versions", "session", "{}"],
      ["nodes", "label", "changed"],
      ["ports", "name", "changed"],
      ["wires", "to_port", "changed"],
    ])("rejects an INSERT OR REPLACE over a version 3 row of %s", (table, column, value) => {
      const db = savedThree();
      const rows = () => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      const before = rows();
      const row = db.prepare(`SELECT * FROM ${table} WHERE version = 3 LIMIT 1`).get() as Record<
        string,
        unknown
      >;
      const columns = Object.keys(row);
      const replace = db.prepare(
        `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((c) => `@${c}`).join(", ")})`,
      );

      expect(() => replace.run({ ...row, [column]: value })).toThrow(
        "saved flow versions are locked",
      );
      expect(rows()).toEqual(before);
    });

    it.each([
      ["nodes", { ordinal: 999, id: "added" }],
      ["ports", { node_id: "added", ordinal: 0 }],
      ["wires", { ordinal: 999 }],
    ])("rejects a plain INSERT of a new %s row into version 3", (table, newKey) => {
      const db = savedThree();
      const rows = () => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      const before = rows();
      const row = db.prepare(`SELECT * FROM ${table} WHERE version = 3 LIMIT 1`).get() as Record<
        string,
        unknown
      >;
      const columns = Object.keys(row);
      const insert = db.prepare(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((c) => `@${c}`).join(", ")})`,
      );

      expect(() => insert.run({ ...row, ...newKey })).toThrow("saved flow versions are locked");
      expect(rows()).toEqual(before);
    });
  });

  describe("many blueprints", () => {
    const ids = (...list: string[]) => {
      const queue = [...list];
      return () => queue.shift() ?? "spare";
    };

    it("creates named blueprints with no versions, and lists them newest first", () => {
      const times = ["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"];
      let tick = 0;
      const store = new SqliteFlowStore({
        db: connect(),
        newId: ids("flow-a", "flow-b"),
        now: () => new Date(times[tick++] ?? "2026-12-31T00:00:00.000Z"),
      });

      expect(store.create("Release notes")).toMatchObject({ flowId: "flow-a", versions: 0 });
      store.create("Triage");

      expect(store.list()).toEqual([
        {
          flowId: "flow-b",
          name: "Triage",
          createdAt: times[1],
          versions: 0,
          lastSavedAt: null,
          buildConfig: null,
          pinned: false,
        },
        {
          flowId: "flow-a",
          name: "Release notes",
          createdAt: times[0],
          versions: 0,
          lastSavedAt: null,
          buildConfig: null,
          pinned: false,
        },
      ]);
      expect(store.loadLatest("flow-a")).toBeNull();
    });

    it("saves each blueprint's versions apart and loads each by id", () => {
      const store = open(ids("flow-a", "flow-b"));
      store.create("A");
      store.create("B");

      expect(store.save(relabelled("a1"), "flow-a")).toEqual({ flowId: "flow-a", version: 1 });
      expect(store.save(relabelled("b1"), "flow-b")).toEqual({ flowId: "flow-b", version: 1 });
      expect(store.save(relabelled("a2"), "flow-a")).toEqual({ flowId: "flow-a", version: 2 });

      expect(store.loadLatest("flow-a")).toEqual({
        flowId: "flow-a",
        name: "A",
        version: 2,
        flow: relabelled("a2"),
      });
      expect(open().loadLatest("flow-b")?.flow).toEqual(relabelled("b1"));
      expect(store.loadLatest()?.flowId).toBe("flow-a");
    });

    it("lists the version count, last save and Build configuration of each, last saved first", () => {
      const times = [
        "2026-01-01T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
        "2026-01-03T00:00:00.000Z",
        "2026-01-04T00:00:00.000Z",
      ];
      let tick = 0;
      const store = new SqliteFlowStore({
        db: connect(),
        newId: ids("flow-a", "flow-b"),
        now: () => new Date(times[tick++] ?? "2026-12-31T00:00:00.000Z"),
      });
      store.create("A");
      store.create("B");
      const inRepo: Flow = {
        ...relabelled("a2"),
        session: {
          ...roundTripFlow().session,
          buildConfig: {
            repo: "/repo",
            base: "dev",
            variables: [{ name: "ticket", kind: "text" }],
          },
        },
      };
      store.save(relabelled("a1"), "flow-a");
      store.save(inRepo, "flow-a");

      expect(store.list()).toEqual([
        {
          flowId: "flow-a",
          name: "A",
          createdAt: times[0],
          versions: 2,
          lastSavedAt: times[3],
          buildConfig: {
            repo: "/repo",
            base: "dev",
            variables: [{ name: "ticket", kind: "text" }],
          },
          pinned: false,
        },
        {
          flowId: "flow-b",
          name: "B",
          createdAt: times[1],
          versions: 0,
          lastSavedAt: null,
          buildConfig: null,
          pinned: false,
        },
      ]);
    });

    it("renames a blueprint without touching its locked versions", () => {
      const store = open(ids("flow-a"));
      store.save(relabelled("a1"));

      store.rename("flow-a", "  Weekly report  ");

      expect(store.loadLatest("flow-a")).toMatchObject({ name: "Weekly report", version: 1 });
      expect(store.load({ flowId: "flow-a", version: 1 })?.flow).toEqual(relabelled("a1"));
      expect(() => store.rename("flow-a", "   ")).toThrow("A blueprint needs a name");
      expect(() => store.rename("nope", "X")).toThrow("No blueprint nope");
      expect(store.list().map((flow) => flow.name)).toEqual(["Weekly report"]);
    });

    it("creates a named blueprint with its version 1 in one save, and nothing when that save fails", () => {
      const store = open(ids("flow-a", "flow-b"));
      const db = raw();
      db.exec("CREATE TRIGGER boom BEFORE INSERT ON wires BEGIN SELECT RAISE(ABORT, 'boom'); END");

      expect(() => store.save(relabelled("a1"), { name: "Report" })).toThrow("boom");
      expect(() => store.save(relabelled("a1"), { name: "  " })).toThrow(
        "A blueprint needs a name",
      );
      expect(count(db, "flows")).toBe(0);

      db.exec("DROP TRIGGER boom");
      expect(store.save(relabelled("a1"), { name: " Report " })).toEqual({
        flowId: "flow-b",
        version: 1,
      });
      expect(store.list()).toEqual([
        expect.objectContaining({ flowId: "flow-b", name: "Report", versions: 1 }),
      ]);
    });

    it("refuses a save to a blueprint that does not exist", () => {
      expect(() => open().save(relabelled("a"), "nope")).toThrow("No blueprint nope");
      expect(count(raw(), "flow_versions")).toBe(0);
    });

    it("lists the one flow of a database saved before blueprints had names", () => {
      const store = open();
      store.save(relabelled("a"));
      store.save(relabelled("b"));

      expect(open().list()).toEqual([
        expect.objectContaining({ flowId: "flow-1", name: "Untitled", versions: 2 }),
      ]);
    });
  });

  describe("pinning", () => {
    const ids = (...list: string[]) => {
      const queue = [...list];
      return () => queue.shift() ?? "spare";
    };

    it("lists a blueprint created before pinning existed as not pinned", async () => {
      const before = join(folder, "migrations-before-pinned");
      await mkdir(before);
      for (const name of await readdir(migrationsDir)) {
        if (name < "010") await copyFile(new URL(name, migrationsDir), join(before, name));
      }
      const old = openDatabase({ path, migrationsDir: before });
      old.prepare("INSERT INTO flows (id, name, created_at) VALUES ('flow-1', 'Old', 't')").run();
      old.close();

      expect(open().list()).toEqual([
        expect.objectContaining({ flowId: "flow-1", name: "Old", pinned: false }),
      ]);
    });

    it("pins and unpins a blueprint, keeping its save time and the last-saved order", () => {
      const times = [
        "2026-01-01T00:00:00.000Z",
        "2026-01-02T00:00:00.000Z",
        "2026-01-03T00:00:00.000Z",
      ];
      let tick = 0;
      const store = new SqliteFlowStore({
        db: connect(),
        newId: ids("flow-a", "flow-b"),
        now: () => new Date(times[tick++] ?? "2026-12-31T00:00:00.000Z"),
      });
      store.create("A");
      store.create("B");
      store.save(relabelled("a1"), "flow-a");
      const unpinned = store.list();
      expect(unpinned.map(({ flowId, pinned }) => ({ flowId, pinned }))).toEqual([
        { flowId: "flow-a", pinned: false },
        { flowId: "flow-b", pinned: false },
      ]);

      store.pin("flow-b", true);

      expect(open().list()).toEqual([
        { ...unpinned[0], pinned: false },
        { ...unpinned[1], pinned: true },
      ]);

      store.pin("flow-b", false);

      expect(open().list()).toEqual(unpinned);
    });
  });

  describe("a version saved with a File wire", () => {
    const agentSettings = {
      role: "implementer",
      instructions: "Implement the plan.",
      model: "sonnet",
      tools: [],
    };

    const storeFileWireVersion = () => {
      open();
      const db = raw();
      db.transaction(() => {
        db.prepare(
          "INSERT INTO flows (id, name, created_at) VALUES ('flow-1', 'Plan and build', 't')",
        ).run();
        const insertNode = db.prepare(
          `INSERT INTO nodes (flow_id, version, ordinal, id, type, label, x, y, parent, settings)
           VALUES ('flow-1', 1, ?, ?, 'agent', ?, 0, 0, NULL, ?)`,
        );
        insertNode.run(0, "plan", "Plan", JSON.stringify(agentSettings));
        insertNode.run(1, "build", "Build", JSON.stringify(agentSettings));
        const insertWire = db.prepare(
          `INSERT INTO wires (flow_id, version, ordinal, kind, from_node, from_port, to_node, to_port, file)
           VALUES ('flow-1', 1, ?, ?, ?, ?, ?, ?, ?)`,
        );
        insertWire.run(0, "then", "plan", "out", "build", "in", null);
        insertWire.run(1, "file", "plan", "file-out", "build", "file-in", "plan.md");
        db.prepare(
          "INSERT INTO flow_versions (flow_id, version, session, notes, saved_at) VALUES ('flow-1', 1, ?, '[]', 't')",
        ).run(
          JSON.stringify({
            name: "main",
            buildConfig: { base: "main", variables: [] },
            model: "sonnet",
            allowedTools: [],
            permissionMode: "default",
            connectors: [],
          }),
        );
      })();
    };

    it("loads with the file in Plan writes and Build given, and only the Then wire", () => {
      storeFileWireVersion();

      const flow = open().load({ flowId: "flow-1", version: 1 })?.flow;

      expect(flow?.nodes.map((node) => [node.id, node.settings])).toEqual([
        ["plan", { ...agentSettings, writes: ["plan.md"] }],
        ["build", { ...agentSettings, given: ["plan.md"] }],
      ]);
      expect(flow?.wires).toEqual([
        { kind: "then", from: { node: "plan", port: "out" }, to: { node: "build", port: "in" } },
      ]);
    });
  });

  describe("a version saved before Build configurations", () => {
    const oldSession = {
      name: "main",
      workingFolder: { kind: "worktree", branch: "dev", repo: "/r/shop" },
      model: "sonnet",
      allowedTools: [],
      permissionMode: "default",
      connectors: [],
    };
    const movedConfig = {
      repo: "/r/shop",
      base: "dev",
      variables: [
        { name: "ticket", kind: "text" },
        { name: "e2e", kind: "yesno", default: true },
      ],
    };

    const storeOldVersion = () => {
      open();
      const db = raw();
      db.transaction(() => {
        db.prepare(
          "INSERT INTO flows (id, name, created_at) VALUES ('flow-1', 'Bugfix', 't')",
        ).run();
        const insertNode = db.prepare(
          `INSERT INTO nodes (flow_id, version, ordinal, id, type, label, x, y, parent, settings)
           VALUES ('flow-1', 1, ?, ?, ?, ?, 0, 0, NULL, ?)`,
        );
        insertNode.run(
          0,
          "start",
          "trigger",
          "Start",
          JSON.stringify({ inputs: ["ticket"], flags: { e2e: true } }),
        );
        insertNode.run(1, "ife2e", "branch", "E2E?", JSON.stringify({ flag: "e2e" }));
        db.prepare(
          "INSERT INTO flow_versions (flow_id, version, session, notes, saved_at) VALUES ('flow-1', 1, ?, '[]', 't')",
        ).run(JSON.stringify(oldSession));
      })();
    };

    const expectMovedConfig = (buildConfig: unknown) => {
      expect(buildConfig).toEqual({
        ...movedConfig,
        variables: expect.arrayContaining(movedConfig.variables) as unknown,
      });
      expect((buildConfig as { variables: unknown[] }).variables).toHaveLength(2);
    };

    const expectMoved = (flow: Flow | undefined) => {
      expectMovedConfig(flow?.session.buildConfig);
      expect(flow?.session).not.toHaveProperty("workingFolder");
      expect(flow?.nodes.map((node) => node.settings)).toEqual([{}, { variable: "e2e" }]);
    };

    it("comes back moved from load", () => {
      storeOldVersion();

      expectMoved(open().load({ flowId: "flow-1", version: 1 })?.flow);
    });

    it("comes back moved from loadLatest", () => {
      storeOldVersion();

      expectMoved(open().loadLatest("flow-1")?.flow);
    });

    it("is listed with its moved Build configuration", () => {
      storeOldVersion();

      const [summary] = open().list();

      expectMovedConfig(summary?.buildConfig);
      expect(summary).not.toHaveProperty("workingFolder");
    });
  });

  it("shares one migrated connection with SqliteStore", () => {
    const db = connect();
    const runs = new SqliteStore({ db });
    const flows = new SqliteFlowStore({ db, newId: () => "flow-1" });

    runs.recordBuild({
      id: "b1",
      hash: "abc",
      name: "fix-login",
      repo: "/repo",
      base: "main",
      values: {},
      dir: "/fd/workspaces/b1",
      files: [],
      nodes: [],
    });
    const { id } = runs.createRun({
      buildDir: "/fd/workspaces/b1",
      inputs: {},
      nodeIds: ["p1"],
      session: { tmuxName: "fd-run", cwd: "/repo", claudeSessionId: "c1" },
      buildId: "b1",
    });
    runs.append(id, "p1", { kind: "sent" });
    flows.save(roundTripFlow());

    expect(runs.events(id).map((event) => event.kind)).toEqual(["sent"]);
    expect(flows.loadLatest()?.flow).toEqual(roundTripFlow());
    expect(db.prepare("SELECT name FROM migrations ORDER BY name").all()).toEqual([
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
    ]);
  });
});
