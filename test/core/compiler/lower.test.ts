import { describe, expect, it } from "vitest";
import { lower } from "../../../src/core/compiler/lower.js";
import { validate } from "../../../src/core/compiler/validate.js";
import type { Flow } from "../../../src/core/flow/schema.js";
import { compileAgent } from "../../../src/core/nodes/agent/compile.js";
import { compilePrompt } from "../../../src/core/nodes/prompt/compile.js";
import {
  agent,
  flow,
  loop,
  output,
  prompt,
  thenWire,
  trigger,
} from "../../fixtures/flow-builders.js";

const sample = (): Flow =>
  flow(
    [
      agent("a"),
      loop("L"),
      prompt("x", { parent: "L" }),
      prompt("p"),
      trigger("start"),
      output("done"),
    ],
    [thenWire("start", "p"), thenWire("p", "a"), thenWire("a", "x"), thenWire("x", "done")],
  );

const nodeOf = <T extends Flow["nodes"][number]["type"]>(input: Flow, id: string, type: T) => {
  const node = input.nodes.find((candidate) => candidate.id === id);
  if (node?.type !== type) throw new Error(`no ${type} node ${id}`);
  return node as Extract<Flow["nodes"][number], { type: T }>;
};

describe("lower", () => {
  it("is given a valid flow", () => {
    expect(validate(sample())).toEqual([]);
  });

  it("lists manifest nodes in run order, not array order", () => {
    expect(lower(sample()).manifest.nodes.map((node) => node.id)).toEqual([
      "start",
      "p",
      "a",
      "L",
      "x",
      "done",
    ]);
  });

  it("records each node's id, type, label, settings, parent and file only", () => {
    const input = sample();
    const entries = lower(input).manifest.nodes;

    expect(entries.find((node) => node.id === "p")).toStrictEqual({
      id: "p",
      type: "prompt",
      label: "p",
      settings: nodeOf(input, "p", "prompt").settings,
      file: "commands/p.md",
    });
    expect(entries.find((node) => node.id === "a")).toStrictEqual({
      id: "a",
      type: "agent",
      label: "a",
      settings: nodeOf(input, "a", "agent").settings,
      file: "agents/a.md",
    });
    expect(entries.find((node) => node.id === "x")).toStrictEqual({
      id: "x",
      type: "prompt",
      label: "x",
      parent: "L",
      settings: nodeOf(input, "x", "prompt").settings,
      file: "commands/x.md",
    });
    expect(entries.find((node) => node.id === "L")).toStrictEqual({
      id: "L",
      type: "loop",
      label: "L",
      settings: nodeOf(input, "L", "loop").settings,
    });
  });

  it("carries version 1, the session and the wires, and no hash", () => {
    const input = sample();
    const { manifest } = lower(input);

    expect(manifest.version).toBe(1);
    expect(manifest.session).toStrictEqual(input.session);
    expect(manifest.wires).toStrictEqual(input.wires);
    expect(manifest).not.toHaveProperty("hash");
  });

  it("compiles one file per prompt and agent node and none for the rest", () => {
    const input = sample();

    expect(lower(input).nodeFiles).toStrictEqual([
      compilePrompt(nodeOf(input, "p", "prompt")),
      compileAgent(nodeOf(input, "a", "agent")),
      compilePrompt(nodeOf(input, "x", "prompt")),
    ]);
  });

  it("ignores node positions", () => {
    const moved = sample();
    moved.nodes = moved.nodes.map((node, i) => ({ ...node, position: { x: i * 100, y: 7 } }));

    expect(lower(moved)).toStrictEqual(lower(sample()));
  });
});
