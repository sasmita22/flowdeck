import { describe, expect, it } from "vitest";
import { agentType } from "../../../../src/core/nodes/agent/execute.js";
import {
  forkTurnText,
  parallelSections,
  unlaunched,
} from "../../../../src/core/nodes/fork/execute.js";
import {
  agent,
  flow,
  fork,
  join,
  loop,
  prompt,
  thenWire,
} from "../../../fixtures/flow-builders.js";

const sectionsOf = (nodes: unknown[], wires: unknown[]) => {
  const parsed = flow(nodes, wires);
  return parallelSections(parsed.nodes, parsed.wires);
};

const problemNodes = (nodes: unknown[], wires: unknown[]) =>
  sectionsOf(nodes, wires).problems.map((problem) => problem.node);

const around = (branches: string[]) =>
  branches.flatMap((branch) => [thenWire("f", branch), thenWire(branch, "j")]);

describe("parallelSections", () => {
  it("resolves a fork, its agent branches in wire order and its join", () => {
    const result = sectionsOf(
      [fork("f"), agent("a3"), agent("a1"), agent("a2"), join("j")],
      around(["a1", "a2", "a3"]),
    );

    expect(result.sections).toEqual([{ fork: "f", join: "j", branches: ["a1", "a2", "a3"] }]);
    expect(result.problems).toEqual([]);
  });

  it("finds nothing in a flow with no fork or join", () => {
    expect(sectionsOf([prompt("p1"), prompt("p2")], [thenWire("p1", "p2")])).toEqual({
      sections: [],
      problems: [],
    });
  });

  it("names the fork when it has fewer than two branches", () => {
    expect(problemNodes([fork("f"), agent("a1"), join("j")], around(["a1"]))).toEqual(["f"]);
  });

  it("names a branch that is not an agent", () => {
    expect(
      problemNodes([fork("f"), agent("a1"), prompt("p2"), join("j")], around(["a1", "p2"])),
    ).toEqual(["p2"]);
  });

  it("names a fork used as a branch, so sections cannot nest", () => {
    expect(
      problemNodes(
        [fork("f"), agent("a1"), fork("inner"), agent("x1"), agent("x2"), join("j")],
        [
          ...around(["a1", "inner"]),
          thenWire("inner", "x1"),
          thenWire("inner", "x2"),
          thenWire("x1", "j"),
          thenWire("x2", "j"),
        ],
      ),
    ).toContain("inner");
  });

  it("names a branch with a second in-wire", () => {
    expect(
      problemNodes(
        [prompt("p"), fork("f"), agent("a1"), agent("a2"), join("j")],
        [...around(["a1", "a2"]), thenWire("p", "a2")],
      ),
    ).toEqual(["a2"]);
  });

  it("names a branch with a second out-wire", () => {
    expect(
      problemNodes(
        [fork("f"), agent("a1"), agent("a2"), join("j"), prompt("p")],
        [...around(["a1", "a2"]), thenWire("a2", "p")],
      ),
    ).toEqual(["a2"]);
  });

  it("names the fork when its branches lead into different joins", () => {
    expect(
      problemNodes(
        [fork("f"), agent("a1"), agent("a2"), join("j1"), join("j2")],
        [thenWire("f", "a1"), thenWire("f", "a2"), thenWire("a1", "j1"), thenWire("a2", "j2")],
      ),
    ).toContain("f");
  });

  it("names the fork when a branch leads into no join", () => {
    expect(
      problemNodes(
        [fork("f"), agent("a1"), agent("a2"), join("j"), prompt("p")],
        [thenWire("f", "a1"), thenWire("f", "a2"), thenWire("a1", "j"), thenWire("a2", "p")],
      ),
    ).toContain("f");
  });

  it("names a join with an in-wire from a node that is not one of the fork's branches", () => {
    expect(
      problemNodes(
        [prompt("p"), fork("f"), agent("a1"), agent("a2"), join("j")],
        [...around(["a1", "a2"]), thenWire("p", "j")],
      ),
    ).toEqual(["j"]);
  });

  it("names a join reached from two forks and resolves neither section", () => {
    const result = sectionsOf(
      [fork("f1"), fork("f2"), agent("a1"), agent("a2"), agent("b1"), agent("b2"), join("j")],
      [
        ...["a1", "a2"].flatMap((branch) => [thenWire("f1", branch), thenWire(branch, "j")]),
        ...["b1", "b2"].flatMap((branch) => [thenWire("f2", branch), thenWire(branch, "j")]),
      ],
    );

    expect(result).toEqual({
      sections: [],
      problems: [
        { node: "j", message: "is a parallel end reached from more than one parallel start." },
      ],
    });
  });

  it("names a join that no fork reaches", () => {
    expect(problemNodes([prompt("p"), join("j")], [thenWire("p", "j")])).toEqual(["j"]);
  });

  it.each(["f", "a1", "j"])("names %s when it sits inside a loop", (inLoop) => {
    const inside = (id: string) => (id === inLoop ? { parent: "L" } : {});
    expect(
      problemNodes(
        [
          loop("L"),
          fork("f", inside("f")),
          agent("a1", inside("a1")),
          agent("a2"),
          join("j", inside("j")),
        ],
        around(["a1", "a2"]),
      ),
    ).toEqual([inLoop]);
  });

  it("gives every problem a message", () => {
    const { problems } = sectionsOf([fork("f"), agent("a1"), join("j")], around(["a1"]));

    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toEqual(expect.any(String));
    expect(problems[0]?.message.length).toBeGreaterThan(0);
  });
});

describe("forkTurnText", () => {
  const text = forkTurnText("h1", ["a1", "a2"]);

  it("names every branch's agent type in quotes", () => {
    expect(text).toContain(`"${agentType("h1", "a1")}"`);
    expect(text).toContain(`"${agentType("h1", "a2")}"`);
  });

  it("asks for all the Agent calls in one message with the prompt Go", () => {
    expect(text).toContain("Agent");
    expect(text).toMatch(/one message/i);
    expect(text).toContain('"Go"');
  });

  it("says not to wait for one agent before starting the next", () => {
    expect(text).toMatch(/(do not|don't|never) wait/i);
  });

  it("names only the branches it is given", () => {
    expect(forkTurnText("h1", ["a1"])).not.toContain(agentType("h1", "a2"));
  });
});

describe("unlaunched", () => {
  it("returns the branch types with no launch, in branch order", () => {
    expect(unlaunched(["h:a1", "h:a2", "h:a3"], ["h:a2", "general-purpose"])).toEqual([
      "h:a1",
      "h:a3",
    ]);
  });

  it("is empty when every branch launched", () => {
    expect(unlaunched(["h:a1", "h:a2"], ["h:a2", "h:a1"])).toEqual([]);
  });
});
