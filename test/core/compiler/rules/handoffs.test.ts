import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/handoffs.js";
import {
  agent,
  branch,
  fork,
  join,
  onMainFlow,
  thenWire,
  wire,
} from "../../../fixtures/flow-builders.js";

const writer = (id: string, file = "spec.md") => agent(id, { settings: { writes: [file] } });
const plan = (file = "spec.md") => ({ ...writer("agent-2", file), label: "Plan" });
const reader = (id: string, file = "spec.md") => agent(id, { settings: { given: [file] } });

const reported = (nodes: unknown[], wires: unknown[]) =>
  rule.check(onMainFlow(nodes, wires)).map(({ rule, node, message }) => ({ rule, node, message }));

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const naming = (...words: string[]) =>
  expect.stringMatching(new RegExp(words.map((word) => `(?=[\\s\\S]*${escape(word)})`).join("")));

const refusal = (node: string, ...words: string[]) => [
  { rule: "handoffs", node, message: naming(...words) },
];

describe("handoffs", () => {
  it("refuses a reader that runs before its writer, naming both", () => {
    expect(reported([reader("builder"), plan()], [thenWire("builder", "agent-2")])).toEqual(
      refusal("builder", "builder", "Plan runs after", "spec.md"),
    );
  });

  it("refuses a reader and writer side by side in a parallel section, naming both", () => {
    expect(
      reported(
        [fork("f"), plan(), reader("builder"), join("j")],
        [
          thenWire("f", "agent-2"),
          thenWire("f", "builder"),
          thenWire("agent-2", "j"),
          thenWire("builder", "j"),
        ],
      ),
    ).toEqual(refusal("builder", "builder", "from Plan", "spec.md"));
  });

  it("refuses a writer on only one Branch arm before the reader, naming both", () => {
    expect(
      reported(
        [branch("br", "e2e"), plan(), reader("builder")],
        [
          wire("br", "yes", "agent-2", "in"),
          thenWire("agent-2", "builder"),
          wire("br", "no", "builder", "in"),
        ],
      ),
    ).toEqual(refusal("builder", "builder", "runs Plan first", "spec.md"));
  });

  it.each([["../spec.md"], ["/etc/spec.md"]])(
    "refuses the paired file %s outside the working folder",
    (file) => {
      expect(
        reported([plan(file), reader("builder", file)], [thenWire("agent-2", "builder")]),
      ).toEqual(refusal("builder", "builder", "written by Plan", file));
    },
  );

  it("leaves an unpaired unsafe given to other rules", () => {
    expect(
      reported(
        [agent("planner"), reader("builder", "../spec.md")],
        [thenWire("planner", "builder")],
      ),
    ).toEqual([]);
  });

  it("accepts a writer before the reader on every path", () => {
    expect(
      reported(
        [branch("br", "e2e"), writer("w1"), writer("w2"), reader("builder")],
        [
          wire("br", "yes", "w1", "in"),
          wire("br", "no", "w2", "in"),
          thenWire("w1", "builder"),
          thenWire("w2", "builder"),
        ],
      ),
    ).toEqual([]);
  });

  it("accepts one Agent that is given and writes the same file", () => {
    expect(
      reported([agent("solo", { settings: { given: ["spec.md"], writes: ["spec.md"] } })], []),
    ).toEqual([]);
  });
});
