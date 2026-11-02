import { describe, expect, it } from "vitest";
import { lower } from "../../../../src/core/compiler/lower.js";
import { rule } from "../../../../src/core/compiler/rules/body-nodes.js";
import { rule as loopBody } from "../../../../src/core/compiler/rules/loop-body.js";
import { structureProblems } from "../../../../src/core/run/runner.js";
import {
  ask,
  flow,
  forEach,
  gate,
  hardstop,
  loop,
  output,
  prompt,
  trigger,
} from "../../../fixtures/flow-builders.js";

const reported = (nodes: unknown[]) =>
  rule.check(flow(nodes, [])).map(({ rule, node, message }) => ({ rule, node, message }));

describe("body-nodes", () => {
  it.each([
    [
      "a Trigger in a Loop",
      [loop("L"), prompt("p", { parent: "L" }), trigger("t", { parent: "L" })],
      "t",
      "t (trigger) cannot be inside loop L.",
    ],
    [
      "an Output in a For each",
      [forEach("E"), prompt("p", { parent: "E" }), output("o", { parent: "E" })],
      "o",
      "o (output) cannot be inside foreach E.",
    ],
  ])("reports %s on that node", (_name, nodes, node, message) => {
    expect(reported(nodes)).toEqual([{ rule: "body-nodes", node, message }]);
  });

  it.each([
    ["a Gate", gate],
    ["an Ask", ask],
    ["a Hard stop", hardstop],
  ])("accepts %s inside a body", (_name, make) => {
    expect(reported([loop("L"), prompt("p", { parent: "L" }), make("x", { parent: "L" })])).toEqual(
      [],
    );
  });

  it("accepts a Trigger and an Output outside every body", () => {
    expect(reported([trigger("t"), loop("L"), prompt("p", { parent: "L" }), output("o")])).toEqual(
      [],
    );
  });

  it("finds, with loop-body, exactly the problems the runner refuses", () => {
    const built = flow(
      [
        loop("L"),
        trigger("t", { parent: "L" }),
        forEach("E"),
        prompt("p", { parent: "E" }),
        output("o", { parent: "E" }),
      ],
      [],
    );
    const { manifest } = lower(built);
    const runner = structureProblems(manifest.nodes, manifest.wires);

    const validator = [...loopBody.check(built), ...rule.check(built)].map(({ message }) =>
      message.replace(/\.$/, ""),
    );
    expect(validator.toSorted()).toEqual(runner.toSorted());
    expect(runner).toContain("t (trigger) cannot be inside loop L");
    expect(runner).toContain("o (output) cannot be inside foreach E");
  });
});
