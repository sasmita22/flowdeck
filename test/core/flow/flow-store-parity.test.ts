import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteFlowStore } from "../../../src/adapters/sqlite/flows.js";
import { openDatabase } from "../../../src/adapters/sqlite/open-database.js";
import type { Flow } from "../../../src/core/flow/schema.js";
import type { FlowStore } from "../../../src/ports/flow-store.js";
import { FakeFlowStore } from "../../fakes/fake-flow-store.js";
import { roundTripFlow } from "../../fixtures/round-trip-flow.js";

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
    const queue = ["flow-a", "flow-b"];
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
