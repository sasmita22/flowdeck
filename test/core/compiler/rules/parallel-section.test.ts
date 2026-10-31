import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/parallel-section.js";
import { validate } from "../../../../src/core/compiler/validate.js";
import { parallelSections } from "../../../../src/core/nodes/fork/execute.js";
import {
  agent,
  flow,
  fork,
  join,
  loop,
  prompt,
  thenWire,
} from "../../../fixtures/flow-builders.js";

const around = (branches: string[]) =>
  branches.flatMap((branch) => [thenWire("f", branch), thenWire(branch, "j")]);

const cases: [string, unknown[], unknown[], string][] = [
  ["a fork with one branch", [fork("f"), agent("a1"), join("j")], around(["a1"]), "f"],
  [
    "a branch that is not an agent",
    [fork("f"), agent("a1"), prompt("p2"), join("j")],
    around(["a1", "p2"]),
    "p2",
  ],
  [
    "a branch with a second in-wire",
    [prompt("p"), fork("f"), agent("a1"), agent("a2"), join("j")],
    [...around(["a1", "a2"]), thenWire("p", "a2")],
    "a2",
  ],
  [
    "a branch with a second out-wire",
    [fork("f"), agent("a1"), agent("a2"), join("j"), prompt("p")],
    [...around(["a1", "a2"]), thenWire("a2", "p")],
    "a2",
  ],
  [
    "branches leading into different joins",
    [fork("f"), agent("a1"), agent("a2"), join("j1"), join("j2")],
    [thenWire("f", "a1"), thenWire("f", "a2"), thenWire("a1", "j1"), thenWire("a2", "j2")],
    "f",
  ],
  [
    "a branch leading into no join",
    [fork("f"), agent("a1"), agent("a2"), join("j"), prompt("p")],
    [thenWire("f", "a1"), thenWire("f", "a2"), thenWire("a1", "j"), thenWire("a2", "p")],
    "f",
  ],
  [
    "a join wired from a node that is not a branch",
    [prompt("p"), fork("f"), agent("a1"), agent("a2"), join("j")],
    [...around(["a1", "a2"]), thenWire("p", "j")],
    "j",
  ],
  [
    "a join reached from two forks",
    [fork("f1"), fork("f2"), agent("a1"), agent("a2"), agent("b1"), agent("b2"), join("j")],
    [
      ...["a1", "a2"].flatMap((branch) => [thenWire("f1", branch), thenWire(branch, "j")]),
      ...["b1", "b2"].flatMap((branch) => [thenWire("f2", branch), thenWire(branch, "j")]),
    ],
    "j",
  ],
  ["a join no fork reaches", [prompt("p"), join("j")], [thenWire("p", "j")], "j"],
  [
    "a section inside a loop",
    [loop("L"), fork("f", { parent: "L" }), agent("a1"), agent("a2"), join("j")],
    around(["a1", "a2"]),
    "f",
  ],
];

describe("parallel-section", () => {
  it("accepts a two-branch section", () => {
    expect(
      rule.check(flow([fork("f"), agent("a1"), agent("a2"), join("j")], around(["a1", "a2"]))),
    ).toEqual([]);
  });

  it("accepts a flow with no fork or join", () => {
    expect(rule.check(flow([prompt("p1"), prompt("p2")], [thenWire("p1", "p2")]))).toEqual([]);
  });

  it.each(cases)("reports %s as each section problem", (_, nodes, wires, named) => {
    const parsed = flow(nodes, wires);
    const errors = rule.check(parsed);

    expect(errors).toEqual(
      parallelSections(parsed.nodes, parsed.wires).problems.map(({ node, message }) => ({
        rule: "parallel-section",
        node,
        message: `${node} ${message}`,
      })),
    );
    expect(errors.map((error) => error.node)).toContain(named);
  });

  it("is a rule named parallel-section with its message", () => {
    expect(rule.id).toBe("parallel-section");
    expect(rule.message).toBe(
      "A parallel start must pair with one parallel end around two or more single Agent branches.",
    );
  });

  it("runs as part of validate", () => {
    const errors = validate(flow([fork("f"), agent("a1"), join("j")], around(["a1"])));

    expect(errors).toContainEqual(expect.objectContaining({ rule: "parallel-section", node: "f" }));
  });
});
