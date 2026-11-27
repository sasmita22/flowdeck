import { describe, expect, it } from "vitest";
import { validate } from "../../../src/core/compiler/validate.js";
import { nodeWarnings } from "../../../src/core/flow/node-warnings.js";
import type { Node } from "../../../src/core/flow/schema.js";
import {
  agent,
  branch,
  fork,
  gate,
  join,
  loop,
  onWorkspaceMainFlow,
  output,
  thenWire,
  trigger,
} from "../../fixtures/flow-builders.js";

const asNode = (node: unknown) => node as Node;

describe("nodeWarnings", () => {
  it("warns that an Always Gate is skipped in automatic runs and auto mode", () => {
    const warnings = nodeWarnings(asNode(gate("g")));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/skipped in automatic runs and auto mode/);
  });

  it("gives a Conditional Gate no warning", () => {
    expect(
      nodeWarnings(asNode(gate("g", { settings: { stopWhen: "conditional", condition: "x" } }))),
    ).toEqual([]);
  });

  it.each([
    ["an Agent", agent("a")],
    ["a Loop", loop("l")],
    ["a Branch", branch("b", "mode")],
    ["a Fork", fork("f")],
    ["a Join", join("j")],
    ["a Start", trigger("t")],
    ["a Stop", output("o")],
  ])("gives %s no warning", (_name, node) => {
    expect(nodeWarnings(asNode(node))).toEqual([]);
  });

  it("never turns into a problem that blocks a save or a build", () => {
    const flow = onWorkspaceMainFlow(
      [agent("a"), gate("g", { settings: { instruction: "Check the plan." } })],
      [thenWire("a", "g")],
    );

    expect(nodeWarnings(asNode(flow.nodes.find((node) => node.id === "g")))).toHaveLength(1);
    expect(validate(flow)).toEqual([]);
  });
});
