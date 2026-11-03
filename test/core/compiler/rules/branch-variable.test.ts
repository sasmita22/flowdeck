import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/branch-variable.js";
import { validate } from "../../../../src/core/compiler/validate.js";
import { parseFlow, type BuildConfig } from "../../../../src/core/flow/schema.js";
import {
  branch,
  flow,
  forEach,
  loop,
  output,
  script,
  thenWire,
  trigger,
  wire,
} from "../../../fixtures/flow-builders.js";

const yesno = (name: string): BuildConfig["variables"][number] => ({ name, kind: "yesno" });

const check = (nodes: unknown[], variables: BuildConfig["variables"], wires: unknown[] = []) => {
  const base = flow(nodes, wires);
  return rule.check({ ...base, session: { ...base.session, buildConfig: { variables } } });
};

describe("branch-variable", () => {
  it.each([
    ["not declared", [{ name: "ticket", kind: "text" as const }]],
    ["declared as text", [{ name: "proceed-e2e", kind: "text" as const }]],
  ])("reports a branch on a variable %s, naming the node and the variable", (_, variables) => {
    const errors = check([trigger("start"), branch("ife2e", "proceed-e2e")], variables);

    expect(errors.map(({ rule, node }) => ({ rule, node }))).toEqual([
      { rule: "branch-variable", node: "ife2e" },
    ]);
    expect(errors[0]?.message).toContain("proceed-e2e");
  });

  it("reports a branch with no variable picked", () => {
    const errors = check([trigger("start"), branch("ife2e", "")], [yesno("proceed-e2e")]);

    expect(errors.map(({ rule, node }) => ({ rule, node }))).toEqual([
      { rule: "branch-variable", node: "ife2e" },
    ]);
  });

  it("accepts a branch on a declared yes/no variable", () => {
    expect(
      check([trigger("start"), branch("ife2e", "proceed-e2e")], [yesno("proceed-e2e")]),
    ).toEqual([]);
  });

  it.each([
    ["a loop", loop("body")],
    ["a for each", forEach("body")],
  ])("reports a branch inside %s", (_, parent) => {
    const errors = check(
      [trigger("start"), parent, branch("ife2e", "e2e", { parent: "body" })],
      [yesno("e2e")],
    );

    expect(errors.map(({ rule, node }) => ({ rule, node }))).toEqual([
      { rule: "branch-variable", node: "ife2e" },
    ]);
    expect(errors[0]?.message).toMatch(/loop or for each/i);
  });

  it.each(["yes", "no"])("accepts a branch wired only on %s", (port) => {
    expect(
      check(
        [trigger("start"), branch("ife2e", "e2e"), script("next"), output("done")],
        [yesno("e2e")],
        [thenWire("start", "ife2e"), wire("ife2e", port, "next", "in"), thenWire("next", "done")],
      ),
    ).toEqual([]);
  });

  it("is the only problem in its broken fixture", () => {
    const fixture = parseFlow(
      JSON.parse(
        readFileSync(
          new URL("../../../fixtures/broken/branch-variable.json", import.meta.url),
          "utf8",
        ),
      ),
    );

    expect(validate(fixture).map(({ rule, node }) => ({ rule, node }))).toEqual([
      { rule: "branch-variable", node: "ife2e" },
    ]);
  });
});
