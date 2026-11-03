import { describe, expect, it } from "vitest";
import { lower } from "../../../src/core/compiler/lower.js";
import { validate } from "../../../src/core/compiler/validate.js";
import type { Flow } from "../../../src/core/flow/schema.js";
import { compileAgent } from "../../../src/core/nodes/agent/compile.js";
import { compilePrompt } from "../../../src/core/nodes/prompt/compile.js";
import {
  agent,
  fileWire,
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

const workspace = { name: "fix-login", values: {} };

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
    expect(lower(sample(), workspace).manifest.nodes.map((node) => node.id)).toEqual([
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
    const entries = lower(input, workspace).manifest.nodes;

    expect(entries.find((node) => node.id === "p")).toStrictEqual({
      id: "p",
      type: "prompt",
      label: "p",
      settings: nodeOf(input, "p", "prompt").settings,
      file: "plugin/commands/p.md",
    });
    expect(entries.find((node) => node.id === "a")).toStrictEqual({
      id: "a",
      type: "agent",
      label: "a",
      settings: nodeOf(input, "a", "agent").settings,
      file: "plugin/agents/a.md",
    });
    expect(entries.find((node) => node.id === "x")).toStrictEqual({
      id: "x",
      type: "prompt",
      label: "x",
      parent: "L",
      settings: nodeOf(input, "x", "prompt").settings,
      file: "plugin/commands/x.md",
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
    const { manifest } = lower(input, workspace);

    expect(manifest.version).toBe(1);
    expect(manifest.session).toStrictEqual(input.session);
    expect(manifest.wires).toStrictEqual(input.wires);
    expect(manifest).not.toHaveProperty("hash");
  });

  it("leaves the session frame out of the manifest", () => {
    const input = sample();
    const unframed = structuredClone(input.session);
    input.session.frame = { nodes: ["p", "a"] };

    expect(lower(input, workspace).manifest.session).toStrictEqual(unframed);
  });

  it("lowers flows that differ only in their session frame to the same manifest", () => {
    const framed = sample();
    framed.session.frame = { nodes: ["p"] };

    expect(lower(framed, workspace)).toStrictEqual(lower(sample(), workspace));
  });

  it("keeps the blueprint's Build configuration in the manifest", () => {
    const input = sample();
    input.session.buildConfig = {
      repo: "/r",
      base: "main",
      variables: [{ name: "ticket", kind: "text" }],
    };

    expect(lower(input, workspace).manifest.session.buildConfig).toStrictEqual({
      repo: "/r",
      base: "main",
      variables: [{ name: "ticket", kind: "text" }],
    });
  });

  it("records the build name as the prefix, the workspace layout and the build's values", () => {
    const { manifest } = lower(sample(), {
      name: "fix-login",
      values: { ticket: "FD-99", "proceed-e2e": true },
    });

    expect(manifest.prefix).toBe("fix-login");
    expect(manifest.layout).toBe("workspace");
    expect(manifest.values).toStrictEqual({ ticket: "FD-99", "proceed-e2e": true });
    expect(manifest).not.toHaveProperty("inputs");
  });

  it("lowers one flow under two build names to manifests that differ only in their prefix", () => {
    const first = lower(sample(), { name: "fix-login", values: {} });
    const second = lower(sample(), { name: "fix-signup", values: {} });

    expect(second.manifest.prefix).toBe("fix-signup");
    expect({ ...second.manifest, prefix: first.manifest.prefix }).toStrictEqual(first.manifest);
    expect(second.nodeFiles).toStrictEqual(first.nodeFiles);
  });

  it("fills the build's values into the prompt and agent files", () => {
    const input = flow(
      [prompt("p", { settings: { instructions: "Fix {{ticket}}" } }), agent("a")],
      [thenWire("p", "a")],
    );
    input.session.buildConfig.variables = [{ name: "ticket", kind: "text" }];

    const files = Object.fromEntries(
      lower(input, { name: "fix-login", values: { ticket: "FD-99" } }).nodeFiles.map(
        ({ path, content }) => [path, content],
      ),
    );

    expect(files["plugin/commands/p.md"]).toContain("Fix FD-99");
    expect(files["plugin/commands/p.md"]).not.toContain("{{ticket}}");
  });

  it("compiles one file per prompt and agent node and none for the rest", () => {
    const input = sample();

    expect(lower(input, workspace).nodeFiles).toStrictEqual([
      compilePrompt(nodeOf(input, "p", "prompt")),
      compileAgent(nodeOf(input, "a", "agent")),
      compilePrompt(nodeOf(input, "x", "prompt")),
    ]);
  });

  describe("File wires", () => {
    const handoff = () =>
      flow(
        [prompt("plan"), agent("build"), prompt("check")],
        [
          thenWire("plan", "build"),
          thenWire("build", "check"),
          fileWire("plan", "build", "plan.md"),
          fileWire("plan", "check", "plan.md"),
          fileWire("build", "check", "diff.md"),
        ],
      );

    it("keeps every File wire, with its file, in the manifest", () => {
      const input = handoff();

      expect(lower(input, workspace).manifest.wires).toStrictEqual(input.wires);
      expect(
        lower(input, workspace).manifest.wires.filter((wire) => wire.kind === "file"),
      ).toHaveLength(3);
    });

    it("tells each producer what to write and each consumer what it is given", () => {
      const files = Object.fromEntries(
        lower(handoff(), workspace).nodeFiles.map(({ path, content }) => [path, content]),
      );

      expect(files["plugin/commands/plan.md"]).toMatch(/\nWrite: plan\.md\n$/);
      expect(files["plugin/agents/build.md"]).toMatch(
        /\nYou are given: plan\.md\nWrite: diff\.md\n$/,
      );
      expect(files["plugin/commands/check.md"]).toMatch(/\nYou are given: plan\.md, diff\.md\n$/);
    });
  });

  it("ignores node positions", () => {
    const moved = sample();
    moved.nodes = moved.nodes.map((node, i) => ({ ...node, position: { x: i * 100, y: 7 } }));

    expect(lower(moved, workspace)).toStrictEqual(lower(sample(), workspace));
  });
});
