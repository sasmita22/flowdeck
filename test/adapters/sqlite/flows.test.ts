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
    it("reopens a saved flow with every type, parent, optional field, file and event wire exactly", () => {
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

  it("writes each wire as plain rows: kind, node id and port name of each end, and file", () => {
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
        file: wire.kind === "file" ? wire.file : null,
      })),
    );
    expect(rows.filter((row) => (row as { file: string | null }).file !== null)).toHaveLength(1);
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

  it("shares one migrated connection with SqliteStore", () => {
    const db = connect();
    const runs = new SqliteStore({ db });
    const flows = new SqliteFlowStore({ db, newId: () => "flow-1" });

    runs.recordBuild({ hash: "abc", dir: "/fd/builds/abc", files: [], nodes: [] });
    const { id } = runs.createRun({
      buildDir: "/fd/builds/abc",
      inputs: {},
      nodeIds: ["p1"],
      session: { tmuxName: "fd-run", cwd: "/repo", claudeSessionId: "c1" },
      buildHash: "abc",
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
    ]);
  });
});
