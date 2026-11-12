import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/branch-value.js";
import { validate } from "../../../../src/core/compiler/validate.js";
import { parseFlow } from "../../../../src/core/flow/schema.js";
import { agent, branch, onMainFlow, thenWire, wire } from "../../../fixtures/flow-builders.js";

const producer = (id: string, value = "tests-passed") =>
  agent(id, { settings: { produces: value } });
const valueBranch = (id: string, value?: string) => ({
  ...branch(id, ""),
  settings: { variable: "", decidedBy: "value", ...(value === undefined ? {} : { value }) },
});

const reported = (nodes: unknown[], wires: unknown[]) =>
  rule.check(onMainFlow(nodes, wires)).map(({ rule, node, message }) => ({ rule, node, message }));

const naming = (...words: string[]) =>
  expect.stringMatching(new RegExp(words.map((word) => `(?=[\\s\\S]*${word})`).join("")));

const refusal = (node: string, ...words: string[]) => [
  { rule: "branch-value", node, message: naming(...words) },
];

const chain = (ids: readonly string[]) => ids.slice(1).map((id, at) => thenWire(ids[at] ?? "", id));

describe("branch-value", () => {
  it("accepts a Branch at step 8 reading a value an Agent at step 3 produces", () => {
    const steps = ["s1", "s2", "check", "s4", "s5", "s6", "s7", "b"];

    expect(
      reported(
        [
          agent("s1"),
          agent("s2"),
          producer("check"),
          agent("s4"),
          agent("s5"),
          agent("s6"),
          agent("s7"),
          valueBranch("b", "tests-passed"),
          agent("yes"),
          agent("no"),
        ],
        [...chain(steps), wire("b", "yes", "yes", "in"), wire("b", "no", "no", "in")],
      ),
    ).toEqual([]);
  });

  it("refuses a value produced on only one arm of an earlier Branch, naming the Branch and the value", () => {
    expect(
      reported(
        [
          valueBranch("first", "other"),
          producer("check"),
          agent("skip"),
          valueBranch("b", "tests-passed"),
          producer("other-src", "other"),
        ],
        [
          thenWire("other-src", "first"),
          wire("first", "yes", "check", "in"),
          wire("first", "no", "skip", "in"),
          thenWire("check", "b"),
          thenWire("skip", "b"),
        ],
      ),
    ).toEqual(refusal("b", "b", "tests-passed"));
  });

  it("accepts a value produced on each arm of an earlier Branch", () => {
    expect(
      reported(
        [
          producer("other-src", "other"),
          valueBranch("first", "other"),
          producer("check"),
          producer("recheck"),
          valueBranch("b", "tests-passed"),
        ],
        [
          thenWire("other-src", "first"),
          wire("first", "yes", "check", "in"),
          wire("first", "no", "recheck", "in"),
          thenWire("check", "b"),
          thenWire("recheck", "b"),
        ],
      ),
    ).toEqual([]);
  });

  it("refuses a value its producer only makes after the Branch, naming the Branch, the value and the producer by label", () => {
    expect(
      reported(
        [valueBranch("b", "tests-passed"), { ...producer("agent-3"), label: "Check" }],
        [wire("b", "yes", "agent-3", "in")],
      ),
    ).toEqual(refusal("b", "b", "tests-passed", "Check produces it"));
  });

  it("refuses a value no Agent produces, naming the Branch and the value", () => {
    expect(
      reported(
        [producer("check", "approved"), valueBranch("b", "tests-passed")],
        [thenWire("check", "b")],
      ),
    ).toEqual(refusal("b", "b", "tests-passed"));
  });

  it("refuses a value-decided Branch with no value picked, naming the Branch", () => {
    expect(reported([producer("check"), valueBranch("b")], [thenWire("check", "b")])).toEqual(
      refusal("b", "b"),
    );
  });

  it("leaves a Branch decided by a build variable to branch-variable", () => {
    expect(reported([agent("check"), branch("b", "e2e")], [thenWire("check", "b")])).toEqual([]);
  });

  it("is the only problem in its broken fixture", () => {
    const fixture = parseFlow(
      JSON.parse(
        readFileSync(
          new URL("../../../fixtures/broken/branch-value.json", import.meta.url),
          "utf8",
        ),
      ),
    );

    expect(validate(fixture).map(({ rule, node }) => ({ rule, node }))).toEqual([
      { rule: "branch-value", node: "ifpassed" },
    ]);
  });
});
