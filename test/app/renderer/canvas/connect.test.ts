import { describe, expect, it } from "vitest";
import { createCanvasStore } from "../../../../src/app/renderer/canvas/store.js";
import type { Flow } from "../../../../src/core/flow/schema.js";
import { agent, flow, thenWire } from "../../../fixtures/flow-builders.js";

const end = (node: string, port: string) => ({ node, port });

const loaded = (current: Flow) => {
  const store = createCanvasStore();
  store.getState().load(current);
  return store;
};

const planned = () =>
  loaded(
    flow([{ ...agent("plan"), label: "Planner" }, agent("build")], [thenWire("plan", "build")]),
  );

describe("drawing a wire", () => {
  it("makes a Then wire between two nodes, as one undoable step", () => {
    const store = loaded(flow([agent("plan"), agent("build")], []));

    expect(store.getState().connect(end("plan", "out"), end("build", "in"))).toBe(true);

    expect(store.getState().flow.wires).toEqual([thenWire("plan", "build")]);
    expect(store.getState().undoStack).toHaveLength(1);

    store.getState().undo();
    expect(store.getState().flow.wires).toEqual([]);
  });

  it.each([
    "naming",
    "nameFile",
    "cancelNaming",
    "renamingWire",
    "startWireRename",
    "renameWire",
    "cancelWireRename",
  ])("has no file name prompt or wire rename: no %s", (key) => {
    expect(planned().getState()).not.toHaveProperty(key);
  });
});

describe("a refused Then wire", () => {
  it("says why it was refused", () => {
    const store = planned();

    expect(store.getState().connect(end("build", "out"), end("plan", "in"))).toBe(false);

    expect(store.getState().message).toBe(
      "Can't connect build to Planner: cycle through plan, build",
    );
  });

  it("says when the two ports are already joined", () => {
    const store = planned();

    expect(store.getState().connect(end("plan", "out"), end("build", "in"))).toBe(false);

    expect(store.getState().message).toBe(
      "Can't connect Planner to build: they are already joined.",
    );
  });
});
