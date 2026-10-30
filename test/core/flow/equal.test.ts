import { describe, expect, it } from "vitest";
import { flowsEqual } from "../../../src/core/flow/equal.js";
import type { Flow } from "../../../src/core/flow/schema.js";
import { agent, flow, prompt, script, thenWire } from "../../fixtures/flow-builders.js";

const nth = <T>(list: T[], index: number): T => {
  const item = list[index];
  if (item === undefined) throw new Error(`no item at ${index}`);
  return item;
};

const fileWire = (from: string, to: string) => ({
  kind: "file",
  from: { node: from, port: "out" },
  to: { node: to, port: "in" },
  file: "plan.md",
});

const base = (): Flow =>
  flow(
    [
      prompt("p1"),
      agent("a1", { parent: "p1", settings: { given: ["plan.md"] } }),
      script("s1", { settings: { args: ["test"] } }),
    ],
    [thenWire("p1", "a1"), fileWire("a1", "s1")],
  );

const reverseKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, inner]) => [key, reverseKeys(inner)]),
    );
  }
  return value;
};

const edited = (edit: (flow: Flow) => void): Flow => {
  const copy = structuredClone(base());
  edit(copy);
  return copy;
};

describe("flowsEqual", () => {
  it("treats a flow as equal to a copy of itself", () => {
    expect(flowsEqual(base(), base())).toBe(true);
  });

  it("ignores the order of object keys", () => {
    const reordered = reverseKeys(base()) as Flow;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(base()));

    expect(flowsEqual(base(), reordered)).toBe(true);
    expect(flowsEqual(reordered, base())).toBe(true);
  });

  it.each<[string, (flow: Flow) => void]>([
    ["a node position", (f) => (nth(f.nodes, 0).position = { x: 10, y: 0 })],
    ["a node label", (f) => (nth(f.nodes, 0).label = "renamed")],
    ["a node parent", (f) => (nth(f.nodes, 1).parent = "s1")],
    ["a setting value", (f) => (nth(f.nodes, 0).settings = { instructions: "Other work." })],
    [
      "a list setting value",
      (f) => (nth(f.nodes, 2).settings = { command: "npm", args: ["lint"] }),
    ],
    ["a wire end", (f) => (nth(f.wires, 0).to = { node: "s1", port: "in" })],
    ["a removed wire", (f) => f.wires.pop()],
    ["a session value", (f) => (f.session.model = "haiku")],
    ["a session working folder", (f) => (f.session.workingFolder = { kind: "path", path: "/x" })],
    ["a session allowed tool", (f) => (f.session.allowedTools = ["Bash(npm test)"])],
    ["a session frame", (f) => (f.session.frame = { nodes: ["p1"] })],
    [
      "a worktree repo",
      (f) => (f.session.workingFolder = { kind: "worktree", branch: "main", repo: "/r" }),
    ],
  ])("tells flows apart by %s", (_, edit) => {
    const other = edited(edit);

    expect(flowsEqual(base(), other)).toBe(false);
    expect(flowsEqual(other, base())).toBe(false);
  });

  it("tells flows apart by the members of their session frames", () => {
    const framed = edited((f) => (f.session.frame = { nodes: ["p1", "a1"] }));
    const fewer = edited((f) => (f.session.frame = { nodes: ["p1"] }));

    expect(flowsEqual(framed, fewer)).toBe(false);
    expect(flowsEqual(fewer, framed)).toBe(false);
  });

  it("tells flows apart by node order", () => {
    const other = edited((f) => f.nodes.reverse());

    expect(flowsEqual(base(), other)).toBe(false);
  });

  it("tells flows apart by wire order", () => {
    const other = edited((f) => f.wires.reverse());

    expect(flowsEqual(base(), other)).toBe(false);
  });

  it("tells an absent optional key from a present one", () => {
    const withoutParent = edited((f) => delete nth(f.nodes, 1).parent);
    const withExpectedOutput = edited(
      (f) => (nth(f.nodes, 0).settings = { instructions: "Do the work.", expectedOutput: "done" }),
    );

    expect(flowsEqual(base(), withoutParent)).toBe(false);
    expect(flowsEqual(withoutParent, base())).toBe(false);
    expect(flowsEqual(base(), withExpectedOutput)).toBe(false);
    expect(flowsEqual(withExpectedOutput, base())).toBe(false);
  });
});
