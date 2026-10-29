import { describe, expect, it } from "vitest";
import { createEngineHandler } from "../../../src/app/engine/engine-handler.js";
import { FakeFlowStore } from "../../fakes/fake-flow-store.js";
import { FakeStore } from "../../fakes/fake-store.js";
import { flow, prompt, thenWire, trigger } from "../../fixtures/flow-builders.js";

const stores = (flows = new FakeFlowStore()) => ({ runs: new FakeStore(), flows });

const savedFlow = () => flow([trigger("start"), prompt("plan")], [thenWire("start", "plan")]);

const failingOpen = () => {
  throw new Error("boom");
};

describe("createEngineHandler", () => {
  it("answers a version request with the injected version under the request's id", () => {
    const handler = createEngineHandler({ version: "1.2.3", openStores: () => stores() });

    expect(handler.handle({ id: 1, type: "version" })).toEqual({ id: 1, ok: true, value: "1.2.3" });
  });

  it("reports the store as ready when it opens", () => {
    const handler = createEngineHandler({ version: "1.2.3", openStores: () => stores() });

    expect(handler.handle({ id: 7, type: "store-status" })).toEqual({
      id: 7,
      ok: true,
      value: { kind: "ready" },
    });
  });

  it("reports the open error as the store status instead of throwing", () => {
    const handler = createEngineHandler({ version: "1.2.3", openStores: failingOpen });

    expect(handler.handle({ id: 2, type: "store-status" })).toEqual({
      id: 2,
      ok: true,
      value: { kind: "error", message: "boom" },
    });
  });

  it("opens the store once however many status requests arrive", () => {
    let opens = 0;
    const handler = createEngineHandler({
      version: "1.2.3",
      openStores: () => {
        opens++;
        return stores();
      },
    });

    handler.handle({ id: 1, type: "store-status" });
    handler.handle({ id: 2, type: "store-status" });
    handler.handle({ id: 3, type: "store-status" });

    expect(opens).toBe(1);
  });

  it("opens the stores once across status, save and load requests", () => {
    let opens = 0;
    const handler = createEngineHandler({
      version: "1.2.3",
      openStores: () => {
        opens++;
        return stores();
      },
    });

    handler.handle({ id: 1, type: "store-status" });
    handler.handle({ id: 2, type: "save-flow", payload: savedFlow() });
    handler.handle({ id: 3, type: "load-latest-flow" });
    handler.handle({ id: 4, type: "save-flow", payload: savedFlow() });

    expect(opens).toBe(1);
  });

  it("saves a valid flow payload as version 1 and keeps it in the flow store", () => {
    const flows = new FakeFlowStore({ newId: () => "flow-a" });
    const handler = createEngineHandler({ version: "1.2.3", openStores: () => stores(flows) });

    expect(handler.handle({ id: 5, type: "save-flow", payload: savedFlow() })).toEqual({
      id: 5,
      ok: true,
      value: { kind: "saved", flowId: "flow-a", version: 1 },
    });
    expect(flows.loadLatest()).toEqual({
      flowId: "flow-a",
      name: "Untitled",
      version: 1,
      flow: savedFlow(),
    });
  });

  it("appends the next version to the same flow on a second save", () => {
    const flows = new FakeFlowStore({ newId: () => "flow-a" });
    const handler = createEngineHandler({ version: "1.2.3", openStores: () => stores(flows) });

    handler.handle({ id: 1, type: "save-flow", payload: savedFlow() });

    expect(handler.handle({ id: 2, type: "save-flow", payload: savedFlow() })).toEqual({
      id: 2,
      ok: true,
      value: { kind: "saved", flowId: "flow-a", version: 2 },
    });
  });

  it("returns an error result and saves nothing when the payload is not a flow", () => {
    const flows = new FakeFlowStore();
    const handler = createEngineHandler({ version: "1.2.3", openStores: () => stores(flows) });

    expect(handler.handle({ id: 3, type: "save-flow", payload: { nodes: "nope" } })).toEqual({
      id: 3,
      ok: true,
      value: { kind: "error", message: expect.stringMatching(/\S/) },
    });
    expect(flows.loadLatest()).toBeNull();
  });

  it("returns the store's error as an error result when the save throws", () => {
    const flows = new FakeFlowStore();
    flows.failNextSave(new Error("disk full"));
    const handler = createEngineHandler({ version: "1.2.3", openStores: () => stores(flows) });

    expect(handler.handle({ id: 4, type: "save-flow", payload: savedFlow() })).toEqual({
      id: 4,
      ok: true,
      value: { kind: "error", message: "disk full" },
    });
    expect(flows.loadLatest()).toBeNull();
  });

  it("loads empty before any save", () => {
    const handler = createEngineHandler({ version: "1.2.3", openStores: () => stores() });

    expect(handler.handle({ id: 6, type: "load-latest-flow" })).toEqual({
      id: 6,
      ok: true,
      value: { kind: "empty" },
    });
  });

  it("loads the saved flow after a save", () => {
    const handler = createEngineHandler({ version: "1.2.3", openStores: () => stores() });

    handler.handle({ id: 1, type: "save-flow", payload: savedFlow() });

    expect(handler.handle({ id: 2, type: "load-latest-flow" })).toEqual({
      id: 2,
      ok: true,
      value: { kind: "loaded", flow: savedFlow() },
    });
  });

  it("returns the store's error as an error result when the load throws", () => {
    const flows = new FakeFlowStore();
    flows.loadLatest = () => {
      throw new Error("database is locked");
    };
    const handler = createEngineHandler({ version: "1.2.3", openStores: () => stores(flows) });

    expect(handler.handle({ id: 7, type: "load-latest-flow" })).toEqual({
      id: 7,
      ok: true,
      value: { kind: "error", message: "database is locked" },
    });
  });

  it("returns error results for save and load when the stores fail to open", () => {
    const handler = createEngineHandler({ version: "1.2.3", openStores: failingOpen });

    expect(handler.handle({ id: 1, type: "save-flow", payload: savedFlow() })).toEqual({
      id: 1,
      ok: true,
      value: { kind: "error", message: "boom" },
    });
    expect(handler.handle({ id: 2, type: "load-latest-flow" })).toEqual({
      id: 2,
      ok: true,
      value: { kind: "error", message: "boom" },
    });
    expect(handler.handle({ id: 3, type: "store-status" })).toEqual({
      id: 3,
      ok: true,
      value: { kind: "error", message: "boom" },
    });
  });
});
