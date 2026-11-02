import { describe, expect, it } from "vitest";
import { createCanvasStore } from "../../../../src/app/renderer/canvas/store.js";
import type { Flow } from "../../../../src/core/flow/schema.js";
import {
  agent,
  fileWire,
  flow,
  fork,
  join,
  prompt,
  script,
  thenWire,
} from "../../../fixtures/flow-builders.js";

const end = (node: string, port: string) => ({ node, port });
const fileOut = (node: string) => end(node, "file-out");
const fileIn = (node: string) => end(node, "file-in");

const loaded = (current: Flow) => {
  const store = createCanvasStore();
  store.getState().load(current);
  return store;
};

const planned = () =>
  loaded(
    flow([{ ...prompt("plan"), label: "Planner" }, script("build")], [thenWire("plan", "build")]),
  );

describe("drawing a File wire", () => {
  it("asks for the file name before adding anything", () => {
    const store = planned();
    const before = store.getState().flow;

    store.getState().connect(fileOut("plan"), fileIn("build"));

    expect(store.getState().flow).toBe(before);
    expect(store.getState().naming).toEqual({ from: fileOut("plan"), to: fileIn("build") });
  });

  it("adds one File wire with the name given, as one undoable step", () => {
    const store = planned();
    store.getState().connect(fileOut("plan"), fileIn("build"));

    expect(store.getState().nameFile(" plan.md ")).toBe(true);

    expect(store.getState().flow.wires).toEqual([
      thenWire("plan", "build"),
      fileWire("plan", "build", "plan.md"),
    ]);
    expect(store.getState().naming).toBeNull();
    expect(store.getState().undoStack).toHaveLength(1);

    store.getState().undo();
    expect(store.getState().flow.wires).toEqual([thenWire("plan", "build")]);

    store.getState().redo();
    expect(store.getState().flow.wires).toHaveLength(2);
  });

  it("adds nothing when naming is cancelled", () => {
    const store = planned();
    const before = store.getState().flow;
    store.getState().connect(fileOut("plan"), fileIn("build"));

    store.getState().cancelNaming();

    expect(store.getState().naming).toBeNull();
    expect(store.getState().flow).toBe(before);
    expect(store.getState().undoStack).toEqual([]);
  });

  it.each([
    [
      "no name",
      "   ",
      "Can't connect plan to build: A File wire from plan to build names no file.",
    ],
    [
      "a name outside the working folder",
      "../plan.md",
      'Can\'t connect plan to build: File wire "../plan.md" from plan to build must name a file inside the working folder, without ~, commas or control characters.',
    ],
    [
      "a name with a comma",
      "plan.md, notes.md",
      'Can\'t connect plan to build: File wire "plan.md, notes.md" from plan to build must name a file inside the working folder, without ~, commas or control characters.',
    ],
  ])("refuses %s, says why and keeps asking", (_name, file, message) => {
    const store = planned();
    store.getState().connect(fileOut("plan"), fileIn("build"));

    expect(store.getState().nameFile(file)).toBe(false);

    expect(store.getState().flow.wires).toEqual([thenWire("plan", "build")]);
    expect(store.getState().message).toBe(message);
    expect(store.getState().naming).not.toBeNull();
  });

  it("refuses a File wire from a node that runs later, and says why", () => {
    const store = planned();
    store.getState().connect(fileOut("build"), fileIn("plan"));

    expect(store.getState().nameFile("out.txt")).toBe(false);

    expect(store.getState().message).toBe(
      "Can't connect build to plan: plan needs out.txt from build, but build runs after it.",
    );
  });

  it("refuses a File wire between two branches of one parallel section, and says why", () => {
    const store = loaded(
      flow(
        [fork("f"), agent("a"), agent("b"), join("j")],
        [thenWire("f", "a"), thenWire("f", "b"), thenWire("a", "j"), thenWire("b", "j")],
      ),
    );
    store.getState().connect(fileOut("a"), fileIn("b"));

    expect(store.getState().nameFile("x.md")).toBe(false);

    expect(store.getState().flow.wires).toHaveLength(4);
    expect(store.getState().message).toBe(
      "Can't connect a to b: b needs x.md from a, but they run at the same time.",
    );
  });

  it("refuses the same file twice between the same nodes but takes a second file", () => {
    const store = planned();
    store.getState().connect(fileOut("plan"), fileIn("build"));
    store.getState().nameFile("plan.md");

    store.getState().connect(fileOut("plan"), fileIn("build"));
    expect(store.getState().nameFile("plan.md")).toBe(false);
    expect(store.getState().message).toBe("Can't connect plan to build: they are already joined.");

    expect(store.getState().nameFile("notes.md")).toBe(true);
    expect(store.getState().flow.wires).toHaveLength(3);
  });

  it("refuses a file port joined to a Then port, and says why", () => {
    const store = planned();
    const before = store.getState().flow;

    expect(store.getState().connect(fileOut("plan"), end("build", "in"))).toBe(false);

    expect(store.getState().flow).toBe(before);
    expect(store.getState().naming).toBeNull();
    expect(store.getState().message).toBe(
      "Can't connect plan to build: a file port joins only another file port.",
    );
  });
});

describe("a refused Then wire", () => {
  it("says why it was refused", () => {
    const store = planned();

    expect(store.getState().connect(end("build", "out"), end("plan", "in"))).toBe(false);

    expect(store.getState().message).toBe("Can't connect build to plan: cycle through plan, build");
  });

  it("says when the two ports are already joined", () => {
    const store = planned();

    expect(store.getState().connect(end("plan", "out"), end("build", "in"))).toBe(false);

    expect(store.getState().message).toBe("Can't connect plan to build: they are already joined.");
  });
});
