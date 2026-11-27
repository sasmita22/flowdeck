import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/branch-variable.js";
import { validate } from "../../../../src/core/compiler/validate.js";
import { parseFlow } from "../../../../src/core/flow/schema.js";
import {
  agent,
  branch,
  flow,
  loop,
  output,
  thenWire,
  trigger,
  wire,
} from "../../../fixtures/flow-builders.js";

const check = (nodes: unknown[], wires: unknown[] = []) => rule.check(flow(nodes, wires));

describe("branch-variable", () => {
  it("reports a branch with no variable picked", () => {
    const errors = check([trigger("start"), branch("ife2e", "")]);

    expect(errors.map(({ rule, node }) => ({ rule, node }))).toEqual([
      { rule: "branch-variable", node: "ife2e" },
    ]);
  });

  it("accepts a branch with a variable name, with nothing declared", () => {
    expect(check([trigger("start"), branch("ife2e", "proceed-e2e")])).toEqual([]);
  });

  it("reports a branch inside a loop", () => {
    const errors = check([
      trigger("start"),
      loop("body"),
      branch("ife2e", "e2e", { parent: "body" }),
    ]);

    expect(errors.map(({ rule, node }) => ({ rule, node }))).toEqual([
      { rule: "branch-variable", node: "ife2e" },
    ]);
    expect(errors[0]?.message).toMatch(/cannot sit inside a loop body\./i);
  });

  it.each(["yes", "no"])("accepts a branch wired only on %s", (port) => {
    expect(
      check(
        [trigger("start"), branch("ife2e", "e2e"), agent("next"), output("done")],
        [thenWire("start", "ife2e"), wire("ife2e", port, "next", "in"), thenWire("next", "done")],
      ),
    ).toEqual([]);
  });

  it("leaves a Branch decided by a value an earlier Agent produces to branch-value", () => {
    const valueBranch = {
      ...branch("ifpassed", ""),
      settings: { variable: "", decidedBy: "value", value: "tests-passed" },
    };
    const producer = agent("check", { settings: { produces: "tests-passed" } });

    expect(
      check(
        [trigger("start"), producer, valueBranch],
        [thenWire("start", "check"), thenWire("check", "ifpassed")],
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
