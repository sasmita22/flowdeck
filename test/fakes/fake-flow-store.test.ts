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
});
