import { describe, expect, it } from "vitest";
import { handoffPairs } from "../../../src/core/flow/handoff.js";
import type { Node } from "../../../src/core/flow/schema.js";

const at = { x: 0, y: 0 };

const agent = (
  id: string,
  files: { given?: string[]; writes?: string[] } = {},
): Extract<Node, { type: "agent" }> => ({
  id,
  label: id.charAt(0).toUpperCase() + id.slice(1),
  position: at,
  type: "agent",
  settings: { role: "", instructions: id, model: "sonnet", tools: [], ...files },
});

const forEach = (id: string, file: string): Node => ({
  id,
  label: id,
  position: at,
  type: "foreach",
  settings: { file },
});

const plan = agent("plan", { writes: ["plan.md"] });
const build = agent("build", { given: ["plan.md"] });

describe("handoffPairs", () => {
  it("pairs a file one Agent is given with the other Agent that writes it", () => {
    expect(handoffPairs([plan, build])).toEqual([
      { file: "plan.md", reader: "build", writers: ["plan"] },
    ]);
  });

  it.each([
    ["a given file nobody writes", [build]],
    [
      "an Agent given the file it writes itself",
      [agent("edit", { given: ["plan.md"], writes: ["plan.md"] })],
    ],
    ["a For each reading a file an Agent writes", [plan, forEach("each", "plan.md")]],
  ])("makes no pair for %s", (_case, nodes) => {
    expect(handoffPairs(nodes)).toEqual([]);
  });

  it("lists every other writer of the file in one pair", () => {
    const review = agent("review", { writes: ["plan.md"] });
    expect(handoffPairs([plan, review, build])).toEqual([
      { file: "plan.md", reader: "build", writers: ["plan", "review"] },
    ]);
  });
});
