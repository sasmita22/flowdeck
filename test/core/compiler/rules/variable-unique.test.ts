import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/variable-unique.js";
import { validate } from "../../../../src/core/compiler/validate.js";
import type { LibraryLookup } from "../../../../src/core/flow/libraries.js";
import { parseFlow } from "../../../../src/core/flow/schema.js";
import { branch, onMainFlow, wire } from "../../../fixtures/flow-builders.js";

const shared = (id: string, variable: string) => ({
  ...branch(id, variable),
  settings: { variable, shared: true },
});

const libraryNode = (id: string) => ({
  id,
  label: "Library",
  position: { x: 0, y: 0 },
  type: "library",
  settings: { libraryId: "review", label: "review", overrides: {} },
});

const both = (first: string, second: string) => [
  wire(first, "yes", second, "in"),
  wire(first, "no", second, "in"),
];

const reported = (nodes: unknown[], wires: unknown[]) =>
  rule
    .check(onMainFlow(nodes, wires))
    .map(({ rule: id, node, field }) => ({ rule: id, node, field }));

describe("variable-unique", () => {
  it("reports only the later of two Branches that type the same variable", () => {
    expect(
      reported([branch("one", "approved"), branch("two", "approved")], both("one", "two")),
    ).toEqual([{ rule: "variable-unique", node: "two", field: "variable" }]);
  });

  it("moves the report when the two Branches swap places in the blueprint's order", () => {
    expect(
      reported([branch("two", "approved"), branch("one", "approved")], both("one", "two")),
    ).toEqual([{ rule: "variable-unique", node: "one", field: "variable" }]);
  });

  it("names the earlier Branch in the message", () => {
    const [error] = rule.check(
      onMainFlow(
        [{ ...branch("one", "approved"), label: "Ready?" }, branch("two", "approved")],
        both("one", "two"),
      ),
    );

    expect(error?.message).toContain("Ready?");
    expect(error?.message).toContain('"approved"');
  });

  it("accepts the later Branch when it picked the variable to share it", () => {
    expect(
      reported([branch("one", "approved"), shared("two", "approved")], both("one", "two")),
    ).toEqual([]);
  });

  it("keeps the report on the later Branch when the earlier one is renamed to its name", () => {
    const before = [branch("one", "docs"), branch("two", "approved")];
    const renamed = [branch("one", "approved"), before[1]];

    expect(reported(before, both("one", "two"))).toEqual([]);
    expect(reported(renamed, both("one", "two"))).toEqual([
      { rule: "variable-unique", node: "two", field: "variable" },
    ]);
  });

  it("clears the report once the earlier Branch is deleted", () => {
    expect(reported([branch("two", "approved")], [])).toEqual([]);
  });

  it("counts only the blueprint's own Branches, leaving a library's variables to variable-clash", () => {
    const libraries: LibraryLookup = () => ({
      name: "Review",
      kind: "node-library",
      sessions: [],
      uses: [],
      sends: ["approved"],
    });
    const flow = onMainFlow([branch("one", "approved"), libraryNode("use")], both("one", "use"));

    expect(rule.check(flow, { libraries })).toEqual([]);
  });

  it("is the only problem in its broken fixture", () => {
    const fixture = parseFlow(
      JSON.parse(
        readFileSync(
          new URL("../../../fixtures/broken/variable-unique.json", import.meta.url),
          "utf8",
        ),
      ),
    );

    expect(validate(fixture).map(({ rule: id, node }) => ({ rule: id, node }))).toEqual([
      { rule: "variable-unique", node: "second" },
    ]);
  });
});
