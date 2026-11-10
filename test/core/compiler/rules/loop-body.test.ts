import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/loop-body.js";
import { structureProblems } from "../../../../src/core/run/runner.js";
import { lower } from "../../../../src/core/compiler/lower.js";
import {
  agent,
  ask,
  flow,
  forEach,
  gate,
  hardstop,
  loop,
  thenWire,
} from "../../../fixtures/flow-builders.js";

const check = (nodes: unknown[], wires: unknown[] = []) => rule.check(flow(nodes, wires));
const reported = (nodes: unknown[], wires: unknown[] = []) =>
  check(nodes, wires).map(({ rule, node, message }) => ({ rule, node, message }));

describe("loop-body", () => {
  it("says a body needs an Agent in its rule message", () => {
    expect(rule.message).toBe(
      "A Loop or For each needs an Agent in its body, cannot sit inside another, and only they can hold a body.",
    );
  });

  it.each([
    ["a fresh Loop", [loop("L")], "L", "L (loop) has no agent in its body."],
    ["a fresh For each", [forEach("E")], "E", "E (foreach) has no agent in its body."],
    [
      "a Loop whose body is an ask and a gate",
      [loop("L"), ask("s1", { parent: "L" }), gate("s2", { parent: "L" })],
      "L",
      "L (loop) has no agent in its body.",
    ],
    [
      "a For each whose body is a hard stop and a gate",
      [forEach("E"), hardstop("s1", { parent: "E" }), gate("g1", { parent: "E" })],
      "E",
      "E (foreach) has no agent in its body.",
    ],
    [
      "a Loop inside a Loop",
      [
        loop("O"),
        agent("p0", { parent: "O" }),
        loop("L", { parent: "O" }),
        agent("p1", { parent: "L" }),
      ],
      "L",
      "L (loop) is inside loop O.",
    ],
    [
      "a For each inside a Loop",
      [
        loop("O"),
        agent("p0", { parent: "O" }),
        { ...forEach("E"), parent: "O" },
        agent("p1", { parent: "E" }),
      ],
      "E",
      "E (foreach) is inside loop O.",
    ],
    [
      "a Loop inside a For each",
      [
        forEach("O"),
        agent("p0", { parent: "O" }),
        loop("L", { parent: "O" }),
        agent("p1", { parent: "L" }),
      ],
      "L",
      "L (loop) is inside foreach O.",
    ],
    [
      "a node whose parent is not a Loop or For each",
      [agent("s1"), agent("p1", { parent: "s1" })],
      "p1",
      "p1 (agent) has parent s1, which is not a loop or foreach.",
    ],
  ])("reports %s on the node the runner names", (_name, nodes, node, message) => {
    expect(reported(nodes)).toEqual([{ rule: "loop-body", node, message }]);
  });

  it.each([
    ["a Loop with an Agent", [loop("L"), agent("p1", { parent: "L" })]],
    ["a For each that starts with an Agent", [forEach("E"), agent("a1", { parent: "E" })]],
    [
      "a For each with a gate before its Agent",
      [forEach("E"), gate("s1", { parent: "E" }), agent("p1", { parent: "E" })],
    ],
    ["a flow with no Loop or For each", [agent("a1"), agent("p1")]],
  ])("accepts %s", (_name, nodes) => {
    expect(check(nodes)).toEqual([]);
  });

  it("leaves a parent that names no node to the references rule", () => {
    expect(check([agent("p1", { parent: "ghost" })])).toEqual([]);
  });

  it.each([
    [[loop("L")], []],
    [[loop("L"), gate("s1", { parent: "L" })], []],
    [
      [
        loop("O"),
        agent("p0", { parent: "O" }),
        loop("L", { parent: "O" }),
        agent("p1", { parent: "L" }),
      ],
      [],
    ],
    [[forEach("E"), agent("a1", { parent: "E" }), agent("p1", { parent: "E" })], []],
    [[agent("s1"), agent("p1", { parent: "s1" })], []],
    [
      [forEach("E"), gate("s1", { parent: "E" }), agent("p1", { parent: "E" }), agent("p2")],
      [thenWire("s1", "p1"), thenWire("E", "p2")],
    ],
  ])("finds exactly the problems the runner refuses (case %#)", (nodes, wires) => {
    const built = flow(nodes, wires);
    const { manifest } = lower(built, { name: "fix-login", values: {} });
    const runner = structureProblems(manifest.nodes, manifest.wires);

    expect(rule.check(built).map(({ message }) => message.replace(/\.$/, ""))).toEqual(runner);
  });
});
