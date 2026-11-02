import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/file-wires.js";
import {
  agent,
  fileWire,
  flow,
  forEach,
  fork,
  join,
  loop,
  prompt,
  script,
  thenWire,
} from "../../../fixtures/flow-builders.js";

const reported = (nodes: unknown[], wires: unknown[]) =>
  rule.check(flow(nodes, wires)).map(({ rule, node, wire, message }) => ({
    rule,
    node,
    wire,
    message,
  }));

const planner = { ...prompt("plan"), label: "Planner" };

describe("file-wires", () => {
  it("accepts a File wire from a node that runs first", () => {
    expect(
      reported(
        [planner, agent("build")],
        [thenWire("plan", "build"), fileWire("plan", "build", "plan.md")],
      ),
    ).toEqual([]);
  });

  it("accepts a File wire into a For each from the node before it", () => {
    expect(
      reported(
        [planner, forEach("each"), prompt("p1", { parent: "each" })],
        [thenWire("plan", "each"), fileWire("plan", "each", "plan.md")],
      ),
    ).toEqual([]);
  });

  it.each([
    ["a path outside the working folder", "/etc/plan.md", '"/etc/plan.md"'],
    ["a path that climbs out", "../plan.md", '"../plan.md"'],
    ["a leading ~", "~/plan.md", '"~/plan.md"'],
    ["a newline", "plan\nmd", '"plan\\nmd"'],
    ["a control character", "plan\u0007.md", '"plan\\u0007.md"'],
    ["a comma", "plan.md, notes.md", '"plan.md, notes.md"'],
  ])("reports a file name with %s on the wire's consumer", (_name, file, quoted) => {
    expect(
      reported(
        [planner, agent("build")],
        [thenWire("plan", "build"), fileWire("plan", "build", file)],
      ),
    ).toEqual([
      {
        rule: "file-wires",
        node: "build",
        wire: 1,
        message: `File wire ${quoted} from plan to build must name a file inside the working folder, without ~, commas or control characters.`,
      },
    ]);
  });

  it.each([["notes/plan.md"], ["plan~.md"], ["my plan.md"]])("accepts the file name %s", (file) => {
    expect(
      reported(
        [planner, agent("build")],
        [thenWire("plan", "build"), fileWire("plan", "build", file)],
      ),
    ).toEqual([]);
  });

  it("reports a file name of only spaces on the wire's consumer", () => {
    expect(
      reported(
        [planner, agent("build")],
        [thenWire("plan", "build"), fileWire("plan", "build", "  ")],
      ),
    ).toEqual([
      {
        rule: "file-wires",
        node: "build",
        wire: 1,
        message: "A File wire from plan to build names no file.",
      },
    ]);
  });

  it("reports a File wire whose producer runs after its consumer", () => {
    expect(
      reported(
        [planner, agent("build")],
        [thenWire("build", "plan"), fileWire("plan", "build", "plan.md")],
      ),
    ).toEqual([
      {
        rule: "file-wires",
        node: "build",
        wire: 1,
        message: "build needs plan.md from plan, but plan runs after it.",
      },
    ]);
  });

  it("reports a File wire between two branches of one parallel section", () => {
    expect(
      reported(
        [fork("f"), agent("a"), agent("b"), join("j")],
        [
          thenWire("f", "a"),
          thenWire("f", "b"),
          thenWire("a", "j"),
          thenWire("b", "j"),
          fileWire("a", "b", "x.md"),
        ],
      ),
    ).toEqual([
      {
        rule: "file-wires",
        node: "b",
        wire: 4,
        message: "b needs x.md from a, but they run at the same time.",
      },
    ]);
  });

  it("accepts a File wire from a parallel branch to the node after the join", () => {
    expect(
      reported(
        [fork("f"), agent("a"), agent("b"), join("j"), script("after")],
        [
          thenWire("f", "a"),
          thenWire("f", "b"),
          thenWire("a", "j"),
          thenWire("b", "j"),
          thenWire("j", "after"),
          fileWire("a", "after", "x.md"),
        ],
      ),
    ).toEqual([]);
  });

  it("reports a File wire from a node to itself", () => {
    expect(reported([script("s1")], [fileWire("s1", "s1", "out.txt")])).toEqual([
      {
        rule: "file-wires",
        node: "s1",
        wire: 0,
        message: "s1 cannot need out.txt from itself.",
      },
    ]);
  });

  it("accepts a producer in a Loop body feeding a node after the Loop", () => {
    expect(
      reported(
        [loop("L"), prompt("p1", { parent: "L" }), script("after")],
        [thenWire("L", "after"), fileWire("p1", "after", "notes.md")],
      ),
    ).toEqual([]);
  });

  it("ignores Then wires", () => {
    expect(reported([prompt("a"), prompt("b")], [thenWire("b", "a")])).toEqual([]);
  });
});
