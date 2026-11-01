import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/branch-flag.js";
import { validate } from "../../../../src/core/compiler/validate.js";
import { parseFlow } from "../../../../src/core/flow/schema.js";
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

const withFlags = (flags: Record<string, unknown>) =>
  trigger("start", { settings: { inputs: [], flags } });

const check = (nodes: unknown[], wires: unknown[] = []) => rule.check(flow(nodes, wires));

describe("branch-flag", () => {
  it.each([
    ["not declared on the trigger", { dryRun: false }],
    ["declared with a text default", { e2e: "yes" }],
    ["declared with a number default", { e2e: 1 }],
  ])("reports a flag %s, naming it", (_, flags) => {
    const errors = check([withFlags(flags), branch("ife2e", "e2e")]);

    expect(errors.map(({ rule }) => rule)).toEqual(["branch-flag"]);
    expect(errors[0]?.node).toBe("ife2e");
    expect(errors[0]?.message).toContain("e2e");
  });

  it("reports a flag when the flow has no trigger", () => {
    expect(check([branch("ife2e", "e2e")]).map(({ node }) => node)).toEqual(["ife2e"]);
  });

  it.each([
    ["a loop", loop("body")],
    ["a for each", forEach("body")],
  ])("reports a branch inside %s", (_, parent) => {
    const errors = check([
      withFlags({ e2e: true }),
      parent,
      branch("ife2e", "e2e", { parent: "body" }),
    ]);

    expect(errors.map(({ rule, node }) => ({ rule, node }))).toEqual([
      { rule: "branch-flag", node: "ife2e" },
    ]);
    expect(errors[0]?.message).toMatch(/loop or for each/i);
  });

  it.each([true, false])("accepts a flag declared with the default %j", (value) => {
    expect(check([withFlags({ e2e: value }), branch("ife2e", "e2e")])).toEqual([]);
  });

  it.each(["yes", "no"])("accepts a branch wired only on %s", (port) => {
    expect(
      check(
        [withFlags({ e2e: true }), branch("ife2e", "e2e"), script("next"), output("done")],
        [thenWire("start", "ife2e"), wire("ife2e", port, "next", "in"), thenWire("next", "done")],
      ),
    ).toEqual([]);
  });

  it("is the only problem in its broken fixture", () => {
    const fixture = parseFlow(
      JSON.parse(
        readFileSync(new URL("../../../fixtures/broken/branch-flag.json", import.meta.url), "utf8"),
      ),
    );

    expect(validate(fixture).map(({ rule, node }) => ({ rule, node }))).toEqual([
      { rule: "branch-flag", node: "ife2e" },
    ]);
  });
});
