import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteFlowStore } from "../../../src/adapters/sqlite/flows.js";
import { openDatabase } from "../../../src/adapters/sqlite/open-database.js";
import { parseFlow, type Flow } from "../../../src/core/flow/schema.js";
import type { FlowStore } from "../../../src/ports/flow-store.js";
import { FakeFlowStore } from "../../fakes/fake-flow-store.js";
import {
  agent,
  branch,
  flowSettings,
  onMainFlow,
  output,
  sessionContainer,
  thenWire,
  trigger,
  wire,
} from "../../fixtures/flow-builders.js";
import { roundTripFlow, unconnectedRoundTripFlow } from "../../fixtures/round-trip-flow.js";

const kinds = [
  ["SqliteFlowStore", "sqlite"],
  ["FakeFlowStore", "fake"],
] as const;

const relabelled = (label: string): Flow => {
  const flow = roundTripFlow();
  return { ...flow, nodes: flow.nodes.map((node, i) => (i === 0 ? { ...node, label } : node)) };
};

const withStores = (kind: (typeof kinds)[number][1]) => {
  const opened: Database.Database[] = [];

  afterEach(() => {
    for (const db of opened.splice(0)) db.close();
  });

  return (): FlowStore => {
    const queue = ["flow-a", "flow-b", "flow-c"];
    const newId = () => queue.shift() ?? "spare";
    if (kind === "fake") return new FakeFlowStore({ newId });
    const db = openDatabase({ path: ":memory:" });
    opened.push(db);
    return new SqliteFlowStore({ db, newId });
  };
};

describe.each(kinds)("%s delete", (_name, kind) => {
  const open = withStores(kind);

  const twoSaved = () => {
    const store = open();
    store.create("A");
    store.create("B");
    store.save(relabelled("b1"), "flow-b");
    store.save(relabelled("a1"), "flow-a");
    return store;
  };

  it("leaves a deleted blueprint out of list and loadLatest, and keeps the other", () => {
    const store = twoSaved();

    store.delete("flow-a");

    expect(store.list().map(({ flowId }) => flowId)).toEqual(["flow-b"]);
    expect(store.loadLatest("flow-a")).toEqual(store.loadLatest("unknown"));
    expect(store.loadLatest()?.flowId).toBe("flow-b");
  });

  it("answers loadLatest with no id as an empty store does once the only blueprint is deleted", () => {
    const store = open();
    store.save(relabelled("a1"), { name: "A" });

    store.delete("flow-a");

    expect(store.loadLatest()).toEqual(open().loadLatest());
    expect(store.list()).toEqual([]);
  });

  it("still loads a deleted blueprint's saved versions by ref", () => {
    const store = twoSaved();

    store.delete("flow-a");

    expect(store.load({ flowId: "flow-a", version: 1 })).toMatchObject({
      flowId: "flow-a",
      version: 1,
      flow: relabelled("a1"),
    });
  });

  it("refuses rename, pin and a targeted save of a deleted blueprint", () => {
    const store = twoSaved();

    store.delete("flow-a");

    expect(() => store.rename("flow-a", "Again")).toThrow();
    expect(() => store.pin("flow-a", true)).toThrow();
    expect(() => store.save(relabelled("a2"), "flow-a")).toThrow();
    expect(store.load({ flowId: "flow-a", version: 2 })).toBeNull();
  });

  it("does not write an untargeted save to the deleted, most recently saved blueprint", () => {
    const store = twoSaved();

    store.delete("flow-a");
    const ref = store.save(relabelled("next"));

    expect(ref.flowId).not.toBe("flow-a");
    expect(store.load({ flowId: "flow-a", version: 2 })).toBeNull();
  });

  it("refuses deleting a blueprint twice, and deleting one that does not exist", () => {
    const store = twoSaved();

    store.delete("flow-a");

    expect(() => store.delete("flow-a")).toThrow();
    expect(() => store.delete("unknown")).toThrow();
  });

  it("answers isDeleted for a deleted, a live and an unknown blueprint", () => {
    const store = twoSaved();

    store.delete("flow-a");

    expect(store.isDeleted("flow-a")).toBe(true);
    expect(store.isDeleted("flow-b")).toBe(false);
    expect(store.isDeleted("unknown")).toBe(false);
  });
});

describe.each(kinds)("%s connections", (_name, kind) => {
  const open = withStores(kind);

  it("reopens a flow with connections equal to the one saved", () => {
    const store = open();
    store.save(roundTripFlow());

    expect(store.loadLatest()?.flow).toEqual(roundTripFlow());
  });

  it.each([
    ["without connections", unconnectedRoundTripFlow()],
    ["with an empty connections list", { ...unconnectedRoundTripFlow(), connections: [] }],
  ])("reopens a flow saved %s with no connections key", (_label, saved) => {
    const store = open();
    store.save(saved);

    expect(store.loadLatest()?.flow).toEqual(unconnectedRoundTripFlow());
    expect(store.loadLatest()?.flow).not.toHaveProperty("connections");
  });
});

const libraryNode = (id: string, libraryId: string, label: string) => ({
  id,
  label: "Library",
  position: { x: 0, y: 0 },
  type: "library",
  settings: { libraryId, label, overrides: {} },
});

const loose = (nodes: unknown[], wires: unknown[], containers: unknown[] = []): Flow =>
  parseFlow({ nodes, wires, containers, settings: flowSettings });

const throughCanvas = (members: unknown[]): Flow => {
  const ids = (members as { id: string }[]).map(({ id }) => id);
  const path = ["canvas-start", ...ids, "canvas-stop"];
  return loose(
    [trigger("canvas-start"), ...members, output("canvas-stop")],
    path.slice(1).map((id, index) => thenWire(path[index] as string, id)),
  );
};

const sessionLibrary = (): Flow =>
  loose(
    [trigger("canvas-start"), trigger("s-start"), output("s-stop"), output("canvas-stop")],
    [
      wire("canvas-start", "out", "session-1", "flow-in"),
      thenWire("s-start", "s-stop"),
      wire("session-1", "flow-out", "canvas-stop", "in"),
    ],
    [
      sessionContainer(["s-start", "s-stop"], {
        name: "android",
        repo: "/repos/android",
        branch: "main",
        model: "haiku",
      }),
      sessionContainer([], { id: "session-off", name: "off the path" }),
    ],
  );

describe.each(kinds)("%s summary", (_name, kind) => {
  const open = withStores(kind);

  const summaryOf = (store: FlowStore, flowId: string) =>
    store.list().find((summary) => summary.flowId === flowId);

  it("tells a workflow, a node library, a session library and an incomplete blueprint apart", () => {
    const store = open();
    store.save(onMainFlow([agent("plan")], []), { name: "Workflow" });
    store.save(throughCanvas([agent("plan")]), { name: "Nodes" });
    store.save(sessionLibrary(), { name: "Sessions" });
    store.create("Empty");

    expect(store.list().map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "Empty", kind: "incomplete" },
      { name: "Sessions", kind: "session-library" },
      { name: "Nodes", kind: "node-library" },
      { name: "Workflow", kind: "workflow" },
    ]);
  });

  it("calls a blueprint a session library when a library it uses is one", () => {
    const store = open();
    store.save(sessionLibrary(), { name: "Sessions" });
    store.save(throughCanvas([libraryNode("use", "flow-a", "Android")]), { name: "Wrapper" });

    expect(summaryOf(store, "flow-b")?.kind).toBe("session-library");
  });

  it("lists the session containers a session library reaches, and none for other kinds", () => {
    const store = open();
    store.save(sessionLibrary(), { name: "Sessions" });
    store.save(throughCanvas([agent("plan")]), { name: "Nodes" });

    expect(summaryOf(store, "flow-a")?.sessions).toEqual([
      { id: "session-1", name: "android", repo: "/repos/android", branch: "main", model: "haiku" },
    ]);
    expect(summaryOf(store, "flow-b")?.sessions).toEqual([]);
  });

  it("lists the variables of the libraries a host uses, grouped by the library that asks", () => {
    const store = open();
    store.save(throughCanvas([branch("scan", "isFullScan")]), { name: "E2E" });
    store.save(throughCanvas([libraryNode("use-e2e", "flow-a", "E2E tests")]), {
      name: "Android",
    });
    store.save(
      onMainFlow(
        [
          agent("say", { settings: { instructions: "Ship {{ticket}}" } }),
          libraryNode("use-android", "flow-b", "Android App"),
        ],
        [thenWire("say", "use-android")],
      ),
      { name: "Host" },
    );

    expect(summaryOf(store, "flow-c")?.variables).toEqual([
      {
        name: "android-app.e2e-tests.isFullScan",
        kind: "yes-no",
        nodeIds: ["android-app-e2e-tests-scan"],
        group: { path: "android-app.e2e-tests", name: "E2E" },
      },
      { name: "ticket", kind: "text", nodeIds: ["say"] },
    ]);
  });

  it("lists the libraries a blueprint uses, on its path and off it", () => {
    const store = open();
    store.save(throughCanvas([agent("plan")]), { name: "On path" });
    store.save(throughCanvas([agent("check")]), { name: "Off path" });
    const host = throughCanvas([libraryNode("use", "flow-a", "On path")]);
    store.save(
      parseFlow({ ...host, nodes: [...host.nodes, libraryNode("stray", "flow-b", "Off")] }),
      {
        name: "Host",
      },
    );

    expect(summaryOf(store, "flow-c")?.uses).toEqual(["flow-a", "flow-b"]);
    expect(summaryOf(store, "flow-a")?.uses).toEqual([]);
  });

  it("still lists a host whose library is gone, with its own variables only", () => {
    const store = open();
    store.save(throughCanvas([branch("scan", "isFullScan")]), { name: "E2E" });
    store.save(
      onMainFlow(
        [
          agent("say", { settings: { instructions: "Ship {{ticket}}" } }),
          libraryNode("use-e2e", "flow-a", "E2E tests"),
        ],
        [thenWire("say", "use-e2e")],
      ),
      { name: "Host" },
    );

    store.delete("flow-a");

    expect(store.list()).toEqual([
      expect.objectContaining({
        name: "Host",
        kind: "workflow",
        variables: [{ name: "ticket", kind: "text", nodeIds: ["say"] }],
      }),
    ]);
  });
});
