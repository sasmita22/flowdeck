import { describe, expect, it } from "vitest";
import { NodeType } from "../../../src/core/flow/schema.js";
import { labelFor, nodeDefaults } from "../../../src/core/nodes/defaults.js";
import { registry } from "../../../src/core/nodes/registry.js";

const entries: Partial<
  Record<string, { settings: { safeParse: (v: unknown) => unknown }; ports: unknown }>
> = registry;
const library = () => {
  const entry = entries.library;
  if (entry === undefined) throw new Error("no library entry in the registry");
  return entry;
};
const parse = (input: unknown) =>
  library().settings.safeParse(input) as { success: boolean; data?: unknown };

describe("library node type", () => {
  it("is one of the node types", () => {
    expect(NodeType.options).toContain("library");
  });

  it("parses a library id and label, with no overrides by default", () => {
    expect(parse({ libraryId: "lib-1", label: "android-app" })).toEqual({
      success: true,
      data: { libraryId: "lib-1", label: "android-app", overrides: {} },
    });
  });

  it("keys overrides by a session container id, each with an optional repo, branch and model", () => {
    const overrides = {
      "session-1": { repo: "/repos/app", branch: "release", model: "opus" },
      "session-2": { branch: "dev" },
      "session-3": {},
    };

    expect(parse({ libraryId: "lib-1", label: "app", overrides })).toEqual({
      success: true,
      data: { libraryId: "lib-1", label: "app", overrides },
    });
  });

  it.each([
    ["a library id that is not text", { libraryId: 1, label: "app" }],
    ["no label", { libraryId: "lib-1" }],
    [
      "an override branch that is not text",
      { libraryId: "lib-1", label: "app", overrides: { s: { branch: 2 } } },
    ],
  ])("refuses %s", (_, input) => {
    expect(parse(input).success).toBe(false);
  });

  it("has one then input named in and one then output named out", () => {
    expect(library().ports).toEqual([
      { name: "in", direction: "in", kind: "then" },
      { name: "out", direction: "out", kind: "then" },
    ]);
  });

  it("has defaults and is shown as Library when unlabelled", () => {
    expect((nodeDefaults as Partial<Record<string, unknown>>).library).toEqual({
      label: "Library",
      settings: { libraryId: "", label: "library", overrides: {} },
    });
    expect(labelFor({ type: "library" as NodeType, label: "" })).toBe("Library");
  });
});
