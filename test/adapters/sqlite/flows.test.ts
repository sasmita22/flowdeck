import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteFlowStore } from "../../../src/adapters/sqlite/flows.js";
import { openDatabase } from "../../../src/adapters/sqlite/open-database.js";
import { SqliteStore } from "../../../src/adapters/sqlite/sqlite-store.js";
import { flowsEqual } from "../../../src/core/flow/equal.js";
import type { CanvasNote, Flow } from "../../../src/core/flow/schema.js";
import { registry } from "../../../src/core/nodes/registry.js";
import {
  agent,
  branch,
  flow,
  flowSettings,
  onMainFlow,
  output,
  sessionContainer,
  thenWire,
  trigger,
  workspaceContainer,
} from "../../fixtures/flow-builders.js";
import { roundTripFlow, unconnectedRoundTripFlow } from "../../fixtures/round-trip-flow.js";

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

    it("reopens a flow's connections exactly", () => {
      open().save(roundTripFlow());

      expect(open().loadLatest()?.flow.connections).toEqual([
        { id: "c1", between: ["session-1", "session-2"] },
      ]);
    });

    it("reopens a flow saved without connections with no connections key", () => {
      open().save(unconnectedRoundTripFlow());

      expect(open().loadLatest()?.flow).toEqual(unconnectedRoundTripFlow());
      expect(open().loadLatest()?.flow).not.toHaveProperty("connections");
    });

    it("reopens a flow saved with an empty connections list with no connections key", () => {
      open().save({ ...unconnectedRoundTripFlow(), connections: [] });

      expect(open().loadLatest()?.flow).toEqual(unconnectedRoundTripFlow());
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

    it("reopens a flow's settings exactly, and the reopened flow equals the saved one", () => {
      const saved = flow(
        [trigger("start"), agent("plan"), output("stop")],
        [thenWire("start", "plan"), thenWire("plan", "stop")],
        { buildModel: "opus", permissionMode: "acceptEdits" },
      );
      open().save(saved);

      const loaded = open().loadLatest()?.flow;

      expect(loaded?.settings).toEqual({ buildModel: "opus", permissionMode: "acceptEdits" });
      expect(loaded !== undefined && flowsEqual(saved, loaded)).toBe(true);
    });

    it("reopens a workspace and two session containers with every setting and member, in order", () => {
      const saved = flow(
        [
          trigger("ws-start"),
          output("ws-stop"),
          trigger("s1-start"),
          agent("plan"),
          output("s1-stop"),
          trigger("s2-start"),
          agent("review"),
          output("s2-stop"),
        ],
        [
          thenWire("ws-start", "ws-stop"),
          thenWire("s1-start", "plan"),
          thenWire("plan", "s1-stop"),
          thenWire("s2-start", "review"),
          thenWire("review", "s2-stop"),
        ],
        flowSettings,
        {
          containers: [
            workspaceContainer(["ws-start", "ws-stop"], { model: "opus" }),
            sessionContainer(["s1-start", "plan", "s1-stop"], {
              name: "build",
              repo: "/work/app",
              branch: "dev",
              model: "sonnet",
            }),
            sessionContainer(["s2-start", "review", "s2-stop"], {
              id: "session-2",
              name: "review",
              repo: "",
              branch: "",
              model: "haiku",
            }),
          ],
        },
      );
      open().save(saved);

      expect(open().loadLatest()?.flow.containers).toEqual(saved.containers);
    });

    it("stores the containers in their own column and an empty object in the old session column", () => {
      const saved = roundTripFlow();
      open().save(saved);

      const row = raw().prepare("SELECT session, containers FROM flow_versions").get() as {
        session: string;
        containers: string;
      };

      expect(row.session).toBe("{}");
      expect(JSON.parse(row.containers)).toEqual(saved.containers);
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
      ["flow_versions", "containers = '[]'"],
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
          kind: "incomplete",
          buildConfig: null,
          variables: [],
          sessions: [],
          uses: [],
          pinned: false,
        },
        {
          flowId: "flow-a",
          name: "Release notes",
          createdAt: times[0],
          versions: 0,
          lastSavedAt: null,
          kind: "incomplete",
          buildConfig: null,
          variables: [],
          sessions: [],
          uses: [],
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

    it("lists the version count, last save, Build configuration and found variables of each, last saved first", () => {
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
      const asking = onMainFlow(
        [branch("decide", "ship"), agent("say", { settings: { instructions: "Say {{ticket}}" } })],
        [thenWire("decide", "say")],
      );
      store.save(onMainFlow([agent("plan")], []), "flow-a");
      store.save(
        {
          ...asking,
          containers: asking.containers.map((container) =>
            container.kind === "session"
              ? { ...container, repo: "/repo", branch: "dev" }
              : container,
          ),
        },
        "flow-a",
      );

      expect(store.list()).toEqual([
        {
          flowId: "flow-a",
          name: "A",
          createdAt: times[0],
          versions: 2,
          lastSavedAt: times[3],
          kind: "workflow",
          buildConfig: { repo: "/repo", base: "dev" },
          variables: [
            { name: "ship", kind: "yes-no", nodeIds: ["decide"] },
            { name: "ticket", kind: "text", nodeIds: ["say"] },
          ],
          sessions: [],
          uses: [],
          pinned: false,
        },
        {
          flowId: "flow-b",
          name: "B",
          createdAt: times[1],
          versions: 0,
          lastSavedAt: null,
          kind: "incomplete",
          buildConfig: null,
          variables: [],
          sessions: [],
          uses: [],
          pinned: false,
        },
      ]);
    });

    it("lists a blueprint with no workspace and no canvas path as incomplete, its Build configuration from its first session container", () => {
      const store = open(ids("flow-a"));
      const library = flow(
        [trigger("a-start"), output("a-stop"), trigger("b-start"), output("b-stop")],
        [thenWire("a-start", "a-stop"), thenWire("b-start", "b-stop")],
        flowSettings,
        {
          containers: [
            sessionContainer(["a-start", "a-stop"], { repo: "/first", branch: "one" }),
            sessionContainer(["b-start", "b-stop"], {
              id: "session-2",
              name: "second",
              repo: "/second",
              branch: "two",
            }),
          ],
        },
      );
      store.save(library, { name: "Parts" });

      expect(store.list()).toEqual([
        expect.objectContaining({
          kind: "incomplete",
          buildConfig: { repo: "/first", base: "one" },
        }),
      ]);
    });

    it("leaves an unset repository and branch out of the Build configuration", () => {
      const store = open(ids("flow-a"));
      store.save(flow([agent("p1")], [], flowSettings, { session: { repo: "", branch: "" } }), {
        name: "Fresh",
      });

      expect(store.list()).toEqual([expect.objectContaining({ buildConfig: {} })]);
    });

    it("lists a workflow with no session container as a workflow with no Build configuration", () => {
      const store = open(ids("flow-a"));
      const workspaceOnly = flow(
        [trigger("ws-start"), output("ws-stop")],
        [thenWire("ws-start", "ws-stop")],
        flowSettings,
        { containers: [workspaceContainer(["ws-start", "ws-stop"])] },
      );
      store.save(workspaceOnly, { name: "Shell" });

      expect(store.list()).toEqual([
        expect.objectContaining({ kind: "workflow", buildConfig: null }),
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

  describe("deleted_at on a blueprint is set once", () => {
    const deletedAt = (db: Database.Database) =>
      db.prepare("SELECT deleted_at FROM flows WHERE id = 'flow-1'").get();

    const saved = () => {
      open().save(relabelled("a"));
      return raw();
    };

    it("lets deleted_at be set once, and refuses clearing or changing it", () => {
      const db = saved();

      db.exec("UPDATE flows SET deleted_at = 100 WHERE id = 'flow-1'");

      expect(deletedAt(db)).toEqual({ deleted_at: 100 });
      expect(() => db.exec("UPDATE flows SET deleted_at = NULL WHERE id = 'flow-1'")).toThrow();
      expect(() => db.exec("UPDATE flows SET deleted_at = 200 WHERE id = 'flow-1'")).toThrow();
      expect(deletedAt(db)).toEqual({ deleted_at: 100 });
    });

    it("still lets name and pinned change, before and after deleted_at is set", () => {
      const db = saved();
      const row = () => db.prepare("SELECT name, pinned FROM flows WHERE id = 'flow-1'").get();

      db.exec("UPDATE flows SET name = 'Live', pinned = 1 WHERE id = 'flow-1'");
      expect(row()).toEqual({ name: "Live", pinned: 1 });

      db.exec("UPDATE flows SET deleted_at = 100 WHERE id = 'flow-1'");
      db.exec("UPDATE flows SET name = 'Gone', pinned = 0 WHERE id = 'flow-1'");
      expect(row()).toEqual({ name: "Gone", pinned: 0 });
    });

    it("keeps a deleted blueprint's versions locked, and marks its row deleted", () => {
      const store = open();
      store.save(relabelled("a"));

      store.delete("flow-1");

      const db = raw();
      expect(() => db.exec("DELETE FROM flow_versions WHERE flow_id = 'flow-1'")).toThrow(
        "saved flow versions are locked",
      );
      expect(count(db, "flow_versions")).toBe(1);
      expect(deletedAt(db)).toEqual({ deleted_at: expect.any(Number) as unknown });
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
      branch: "flowdeck/fix-login",
      branchCreated: true,
      values: {},
      dir: "/fd/workspaces/b1",
      files: [],
      nodes: [],
      manifest: "{}",
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
    ]);
  });
});
