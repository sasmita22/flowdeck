import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { order } from "../../../src/core/flow/order.js";
import { NodeType, parseFlow } from "../../../src/core/flow/schema.js";
import { upgradeFlow } from "../../../src/core/flow/upgrade.js";

const readExample = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../examples/${name}`, import.meta.url), "utf8"));

describe("examples", () => {
  it("parses three-agents.json", () => {
    expect(() => parseFlow(readExample("three-agents.json"))).not.toThrow();
  });

  it.each([
    ["three-agents.json", ["start", "p1", "p2", "p3", "done"]],
    ["loop-review.json", ["start", "review", "fix", "check", "done"]],
    [
      "all-types.json",
      [
        "start",
        "plan",
        "build",
        "split",
        "review-a",
        "review-b",
        "merge",
        "lint",
        "ife2e",
        "approve",
        "choose",
        "stop",
        "retry",
        "attempt",
        "e1",
        "e1p1",
        "done",
      ],
    ],
  ])("orders %s", (name, expected) => {
    expect(order(parseFlow(readExample(name)))).toEqual(expected);
  });

  it("uses every node type in all-types.json", () => {
    const types = parseFlow(readExample("all-types.json")).nodes.map((node) => node.type);
    expect(new Set(types)).toEqual(new Set(NodeType.options));
  });
});

const flowFolders = ["examples/", "test/fixtures/", "test/fixtures/broken/"];

const storedFlows = flowFolders.flatMap((folder) => {
  const url = new URL(`../../../${folder}`, import.meta.url);
  return readdirSync(url)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({
      file: `${folder}${name}`,
      raw: JSON.parse(readFileSync(new URL(name, url), "utf8")) as unknown,
    }))
    .filter(({ raw }) => typeof raw === "object" && raw !== null && "session" in raw);
});

describe("stored flows", () => {
  it("finds the example and fixture flows", () => {
    expect(storedFlows.map(({ file }) => file)).toEqual(
      expect.arrayContaining([
        "examples/all-types.json",
        "test/fixtures/agent-then-ask.json",
        "test/fixtures/broken/no-cycle.json",
      ]),
    );
  });

  it.each(storedFlows)("$file is already in the current shape", ({ raw }) => {
    expect(upgradeFlow(structuredClone(raw))).toEqual(raw);
  });
});
