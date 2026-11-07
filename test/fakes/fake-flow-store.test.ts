import { describe, expect, it } from "vitest";
import type { Flow } from "../../src/core/flow/schema.js";
import { flow, prompt, thenWire } from "../fixtures/flow-builders.js";
import { FakeFlowStore } from "./fake-flow-store.js";

const nth = <T>(list: T[], index: number): T => {
  const item = list[index];
  if (item === undefined) throw new Error(`no item at ${index}`);
  return item;
};

const flowOf = (...ids: string[]): Flow =>
  flow(
    ids.map((id) => prompt(id)),
    ids.slice(1).map((id, index) => thenWire(nth(ids, index), id)),
  );

const ids = (...values: string[]) => {
  const queue = [...values];
  return () => queue.shift() ?? "unexpected-id";
};

describe("FakeFlowStore", () => {
  it("loads nothing when empty", () => {
    expect(new FakeFlowStore().loadLatest()).toBeNull();
  });

  it("saves version 1 of a new flow under the injected id", () => {
    const store = new FakeFlowStore({ newId: ids("flow-1") });

    expect(store.save(flowOf("p1"))).toEqual({ flowId: "flow-1", version: 1 });
  });

  it("appends versions 2 and 3 to the same flow", () => {
    const store = new FakeFlowStore({ newId: ids("flow-1", "flow-2") });

    store.save(flowOf("p1"));

    expect(store.save(flowOf("p1", "p2"))).toEqual({ flowId: "flow-1", version: 2 });
    expect(store.save(flowOf("p1", "p2", "p3"))).toEqual({ flowId: "flow-1", version: 3 });
  });

  it("loads a chosen saved version, and nothing for one never saved", () => {
    const store = new FakeFlowStore({ newId: ids("flow-1") });
    store.save(flowOf("p1"));
    store.save(flowOf("p1", "p2"));

    expect(store.load({ flowId: "flow-1", version: 1 })).toEqual({
      flowId: "flow-1",
      name: "Untitled",
      version: 1,
      flow: flowOf("p1"),
    });
    expect(store.load({ flowId: "flow-1", version: 3 })).toBeNull();
    expect(store.load({ flowId: "nope", version: 1 })).toBeNull();
  });

  it("loads the last saved flow as Untitled at its latest version", () => {
    const store = new FakeFlowStore({ newId: ids("flow-1") });
    store.save(flowOf("p1"));
    store.save(flowOf("p1", "p2"));

    expect(store.loadLatest()).toEqual({
      flowId: "flow-1",
      name: "Untitled",
      version: 2,
      flow: flowOf("p1", "p2"),
    });
  });

  it("keeps what it stored when the saved flow is changed afterwards", () => {
    const store = new FakeFlowStore({ newId: ids("flow-1") });
    const saved = flowOf("p1", "p2");

    store.save(saved);
    nth(saved.nodes, 0).label = "changed";
    saved.wires.pop();

    expect(store.loadLatest()?.flow).toEqual(flowOf("p1", "p2"));
  });

  it("keeps what it stored when a loaded flow is changed", () => {
    const store = new FakeFlowStore({ newId: ids("flow-1") });
    store.save(flowOf("p1", "p2"));

    const loaded = store.loadLatest();
    if (loaded === null) expect.fail("nothing loaded");
    nth(loaded.flow.nodes, 0).label = "changed";
    loaded.flow.wires.pop();

    expect(store.loadLatest()?.flow).toEqual(flowOf("p1", "p2"));
  });

  it("throws the given error on the next save only, and stores nothing for it", () => {
    const store = new FakeFlowStore({ newId: ids("flow-1") });
    store.save(flowOf("p1"));
    const error = new Error("disk full");

    store.failNextSave(error);

    expect(() => store.save(flowOf("p1", "p2"))).toThrow(error);
    expect(store.loadLatest()).toEqual({
      flowId: "flow-1",
      name: "Untitled",
      version: 1,
      flow: flowOf("p1"),
    });
    expect(store.save(flowOf("p1", "p3"))).toEqual({ flowId: "flow-1", version: 2 });
  });

  it("throws on the first save and still starts the flow at version 1 afterwards", () => {
    const store = new FakeFlowStore({ newId: ids("flow-1", "flow-2") });

    store.failNextSave(new Error("disk full"));

    expect(() => store.save(flowOf("p1"))).toThrow("disk full");
    expect(store.loadLatest()).toBeNull();
    expect(store.save(flowOf("p1"))).toMatchObject({ version: 1 });
  });

  it("creates a named blueprint with its version 1 in one save, and nothing when that save fails", () => {
    const store = new FakeFlowStore({ newId: ids("flow-a", "flow-b") });
    store.failNextSave(new Error("disk full"));

    expect(() => store.save(flowOf("p1"), { name: "Report" })).toThrow("disk full");
    expect(() => store.save(flowOf("p1"), { name: " " })).toThrow("A blueprint needs a name");
    expect(store.list()).toEqual([]);

    expect(store.save(flowOf("p1"), { name: " Report " })).toEqual({
      flowId: "flow-a",
      version: 1,
    });
    expect(store.list()).toEqual([
      expect.objectContaining({ flowId: "flow-a", name: "Report", versions: 1 }),
    ]);
  });

  it("keeps named blueprints apart, renames them and lists the last saved first", () => {
    const store = new FakeFlowStore({ newId: ids("flow-a", "flow-b") });
    store.create("A");
    store.create("B");

    expect(store.save(flowOf("p1"), "flow-a")).toEqual({ flowId: "flow-a", version: 1 });
    store.rename("flow-a", "Renamed");

    expect(store.loadLatest("flow-a")).toMatchObject({ name: "Renamed", version: 1 });
    expect(store.loadLatest("flow-b")).toBeNull();
    expect(store.list().map(({ flowId, name, versions }) => ({ flowId, name, versions }))).toEqual([
      { flowId: "flow-a", name: "Renamed", versions: 1 },
      { flowId: "flow-b", name: "B", versions: 0 },
    ]);
    expect(() => store.save(flowOf("p1"), "nope")).toThrow("No blueprint nope");
  });

  it("lists a new blueprint as not pinned, pins and unpins it, keeping its save time and the order", () => {
    const store = new FakeFlowStore({ newId: ids("flow-a", "flow-b") });
    store.create("A");
    store.create("B");
    store.save(flowOf("p1"), "flow-a");
    const unpinned = store.list();
    expect(unpinned.map(({ flowId, pinned }) => ({ flowId, pinned }))).toEqual([
      { flowId: "flow-a", pinned: false },
      { flowId: "flow-b", pinned: false },
    ]);

    store.pin("flow-b", true);

    expect(store.list()).toEqual([
      { ...unpinned[0], pinned: false },
      { ...unpinned[1], pinned: true },
    ]);

    store.pin("flow-b", false);

    expect(store.list()).toEqual(unpinned);
  });
});
