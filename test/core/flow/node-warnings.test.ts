import { describe, expect, it } from "vitest";
import { validate } from "../../../src/core/compiler/validate.js";
import { nodeWarnings } from "../../../src/core/flow/node-warnings.js";
import type { Flow } from "../../../src/core/flow/schema.js";
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
  workspaceFlow,
} from "../../fixtures/flow-builders.js";

const alone = (node: { id: string }): Flow => onWorkspaceMainFlow([node], []);

const warningsOf = (flow: Flow, id: string): string[] => nodeWarnings(flow)[id] ?? [];

const producing = (id: string, label: string) => ({
  ...agent(id, {
    settings: { produces: [{ variable: "approved", yesIf: "it holds", noIf: "it does not" }] },
  }),
  label,
});

describe("nodeWarnings", () => {
  it("warns that an Always Gate is skipped in automatic runs and auto mode", () => {
    const warnings = warningsOf(alone(gate("g")), "g");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/skipped in automatic runs and auto mode/);
  });

  it("gives a Conditional Gate no warning", () => {
    expect(
      warningsOf(alone(gate("g", { settings: { stopWhen: "conditional", condition: "x" } })), "g"),
    ).toEqual([]);
  });

  it.each([
    ["an Agent", agent("a")],
    ["a Loop", loop("l")],
    ["a Branch", branch("b", "mode")],
    ["a Fork", fork("f")],
    ["a Join", join("j")],
  ])("gives %s no warning", (_name, node) => {
    expect(warningsOf(alone(node), node.id)).toEqual([]);
  });

  it.each([
    ["a Start", trigger("t")],
    ["a Stop", output("o")],
  ])("gives %s no warning", (_name, node) => {
    expect(warningsOf(workspaceFlow([node], []), node.id)).toEqual([]);
  });

  it("never turns into a problem that blocks a save or a build", () => {
    const flow = onWorkspaceMainFlow(
      [agent("a"), gate("g", { settings: { instruction: "Check the plan." } })],
      [thenWire("a", "g")],
    );

    expect(warningsOf(flow, "g")).toHaveLength(1);
    expect(validate(flow)).toEqual([]);
  });

  describe("two Agents producing one variable", () => {
    const inSequence = () =>
      onWorkspaceMainFlow(
        [
          producing("review", "Reviewer"),
          producing("recheck", "Rechecker"),
          branch("decide", "approved"),
        ],
        [thenWire("review", "recheck"), thenWire("recheck", "decide")],
      );

    it("warns the earlier of two in a row before the Branch, naming the later one", () => {
      const warnings = warningsOf(inSequence(), "review");

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("Rechecker");
      expect(warnings[0]).toContain('"approved"');
    });

    it("gives the later one no warning", () => {
      expect(warningsOf(inSequence(), "recheck")).toEqual([]);
    });

    it("still lets the blueprint build", () => {
      expect(validate(inSequence()).filter(({ node }) => node === "review")).toEqual([]);
    });

    it("warns each of two side by side in a parallel section before the Branch", () => {
      const flow = onWorkspaceMainFlow(
        [
          fork("split"),
          producing("review", "Reviewer"),
          producing("recheck", "Rechecker"),
          join("meet"),
          branch("decide", "approved"),
        ],
        [
          thenWire("split", "review"),
          thenWire("split", "recheck"),
          thenWire("review", "meet"),
          thenWire("recheck", "meet"),
          thenWire("meet", "decide"),
        ],
      );

      expect(warningsOf(flow, "review")).toEqual([expect.stringContaining("Rechecker")]);
      expect(warningsOf(flow, "recheck")).toEqual([expect.stringContaining("Reviewer")]);
    });
  });

  it("gives a lone producer no warning", () => {
    const flow = onWorkspaceMainFlow(
      [producing("review", "Reviewer"), branch("decide", "approved")],
      [thenWire("review", "decide")],
    );

    expect(warningsOf(flow, "review")).toEqual([]);
  });
});
