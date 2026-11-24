import { describe, expect, it } from "vitest";
import { createCanvasStore } from "../../../../src/app/renderer/canvas/store.js";
import {
  overriddenLibrary,
  renamedLibrary,
  sessionValue,
} from "../../../../src/app/renderer/inspector/library-form.js";
import type { LibrarySession } from "../../../../src/core/flow/libraries.js";
import type { Node } from "../../../../src/core/flow/schema.js";
import { flow, flowSettings, output, thenWire, trigger } from "../../../fixtures/flow-builders.js";

type LibraryNode = Extract<Node, { type: "library" }>;

const android: LibrarySession = {
  id: "android",
  name: "android",
  repo: "/repos/android",
  branch: "main",
  model: "sonnet",
};

const use = (overrides: LibraryNode["settings"]["overrides"] = {}): LibraryNode => ({
  id: "use",
  type: "library",
  label: "android-app",
  position: { x: 200, y: 0 },
  settings: { libraryId: "f-android", label: "android-app", overrides },
});

describe("renamedLibrary", () => {
  it("sets the label the build prefixes with and the label the canvas shows", () => {
    expect(renamedLibrary(use(), "tablet app")).toEqual({
      ...use(),
      label: "tablet app",
      settings: { ...use().settings, label: "tablet app" },
    });
  });
});

describe("sessionValue", () => {
  it("shows the library's own setting when the node overrides nothing", () => {
    expect(sessionValue(use(), android, "branch")).toBe("main");
  });

  it("shows the node's override when it has one", () => {
    expect(sessionValue(use({ android: { branch: "mc-branch" } }), android, "branch")).toBe(
      "mc-branch",
    );
  });
});

describe("overriddenLibrary", () => {
  it("writes a changed setting under the session's id on the node only", () => {
    expect(overriddenLibrary(use(), android, "branch", "mc-branch").settings.overrides).toEqual({
      android: { branch: "mc-branch" },
    });
  });

  it("keeps the other overrides of the session", () => {
    expect(
      overriddenLibrary(use({ android: { repo: "/elsewhere" } }), android, "model", "haiku")
        .settings.overrides,
    ).toEqual({ android: { repo: "/elsewhere", model: "haiku" } });
  });

  it.each([
    ["cleared", ""],
    ["set back to the library's own value", "main"],
  ])("removes the override key when the field is %s", (_, value) => {
    expect(
      overriddenLibrary(
        use({ android: { branch: "mc-branch", model: "haiku" } }),
        android,
        "branch",
        value,
      ).settings.overrides,
    ).toEqual({ android: { model: "haiku" } });
  });

  it("removes the session's entry once it overrides nothing", () => {
    expect(
      overriddenLibrary(use({ android: { branch: "mc-branch" } }), android, "branch", "").settings
        .overrides,
    ).toEqual({});
  });
});

describe("editing a library node through the canvas", () => {
  const canvasWith = () => {
    const store = createCanvasStore();
    store
      .getState()
      .load(
        flow(
          [trigger("go"), use(), output("end")],
          [thenWire("go", "use"), thenWire("use", "end")],
          flowSettings,
          { containers: [] },
        ),
      );
    return store;
  };

  const nodeIn = (store: ReturnType<typeof canvasWith>) =>
    store.getState().flow.nodes.find((node) => node.id === "use");

  it("renames in one undoable step", () => {
    const store = canvasWith();
    const before = store.getState().flow;

    store.getState().updateNode(renamedLibrary(use(), "tablet"));

    expect(nodeIn(store)).toMatchObject({ label: "tablet", settings: { label: "tablet" } });
    store.getState().undo();
    expect(store.getState().flow).toEqual(before);
  });

  it("overrides in one undoable step", () => {
    const store = canvasWith();
    const before = store.getState().flow;

    store.getState().updateNode(overriddenLibrary(use(), android, "branch", "mc-branch"));

    expect(nodeIn(store)).toMatchObject({
      settings: { overrides: { android: { branch: "mc-branch" } } },
    });
    store.getState().undo();
    expect(store.getState().flow).toEqual(before);
  });
});
