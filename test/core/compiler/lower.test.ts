import { describe, expect, it } from "vitest";
import { lower } from "../../../src/core/compiler/lower.js";
import { pieceNames } from "../../../src/core/compiler/pieces.js";
import { validate } from "../../../src/core/compiler/validate.js";
import type { Flow } from "../../../src/core/flow/schema.js";
import { compileAgent } from "../../../src/core/nodes/agent/compile.js";
import { sectionOf } from "../../fixtures/frontmatter.js";
import {
  agent,
  fileWire,
  flow,
  loop,
  output,
  thenWire,
  trigger,
} from "../../fixtures/flow-builders.js";

const sample = (): Flow =>
  flow(
    [
      agent("a"),
      loop("L"),
      agent("x", { parent: "L" }),
      agent("p"),
      trigger("start"),
      output("done"),
    ],
    [thenWire("start", "p"), thenWire("p", "a"), thenWire("a", "x"), thenWire("x", "done")],
  );

const workspace = {
  name: "fix-login",
  values: {},
  repo: "/Users/dev/code/carousell-web",
  workspace: "/fd-home/workspaces/b1",
};

const scope = { build: "fix-login", repo: "carousell-web", workspace: "/fd-home/workspaces/b1" };

const labelled = <T extends { label: string }>(node: T, label: string): T => ({ ...node, label });

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

  it("records each node's id, type, label, settings, parent, piece and file only", () => {
    const input = sample();
    const entries = lower(input, workspace).manifest.nodes;

    expect(entries.find((node) => node.id === "p")).toStrictEqual({
      id: "p",
      type: "agent",
      label: "p",
      settings: nodeOf(input, "p", "agent").settings,
      file: "plugin/agents/p.md",
      piece: "p",
    });
    expect(entries.find((node) => node.id === "a")).toStrictEqual({
      id: "a",
      type: "agent",
      label: "a",
      settings: nodeOf(input, "a", "agent").settings,
      file: "plugin/agents/a.md",
      piece: "a",
    });
    expect(entries.find((node) => node.id === "x")).toStrictEqual({
      id: "x",
      type: "agent",
      label: "x",
      parent: "L",
      settings: nodeOf(input, "x", "agent").settings,
      file: "plugin/agents/x.md",
      piece: "x",
    });
    expect(entries.find((node) => node.id === "L")).toStrictEqual({
      id: "L",
      type: "loop",
      label: "L",
      settings: nodeOf(input, "L", "loop").settings,
    });
  });

  it("names each Agent node's piece by pieceNames, and points its file at that piece", () => {
    const input = flow(
      [
        labelled(agent("p1"), "Sync with base branch"),
        labelled(agent("a1"), "Review"),
        labelled(agent("p2"), "Review"),
        labelled(agent("a2"), "run"),
        trigger("start"),
      ],
      [thenWire("start", "p1"), thenWire("p1", "a1"), thenWire("a1", "p2"), thenWire("p2", "a2")],
    );
    const pieces = pieceNames(input);

    const named = lower(input, workspace).manifest.nodes.map(({ id, piece, file }) => ({
      id,
      piece,
      file,
    }));

    expect(named).toStrictEqual([
      { id: "start", piece: undefined, file: undefined },
      { id: "p1", piece: pieces.get("p1"), file: `plugin/agents/${pieces.get("p1")}.md` },
      { id: "a1", piece: pieces.get("a1"), file: `plugin/agents/${pieces.get("a1")}.md` },
      { id: "p2", piece: pieces.get("p2"), file: `plugin/agents/${pieces.get("p2")}.md` },
      { id: "a2", piece: pieces.get("a2"), file: `plugin/agents/${pieces.get("a2")}.md` },
    ]);
    expect(named.map(({ piece }) => piece)).toEqual([
      undefined,
      "sync-with-base-branch",
      "review",
      "review-2",
      "run-2",
    ]);
  });

  it("records the kit version when the inputs give one, and none otherwise", () => {
    expect(lower(sample(), { ...workspace, kitVersion: "0123456789ab" }).manifest.kitVersion).toBe(
      "0123456789ab",
    );
    expect(lower(sample(), workspace).manifest).not.toHaveProperty("kitVersion");
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
      ...workspace,
      name: "fix-login",
      values: { ticket: "FD-99", "proceed-e2e": true },
    });

    expect(manifest.prefix).toBe("fix-login");
    expect(manifest.layout).toBe("workspace");
    expect(manifest.values).toStrictEqual({ ticket: "FD-99", "proceed-e2e": true });
    expect(manifest).not.toHaveProperty("inputs");
  });

  it("lowers one flow under two build names to manifests that differ only in their prefix, and files that differ only in the build named", () => {
    const first = lower(sample(), workspace);
    const second = lower(sample(), { ...workspace, name: "fix-signup" });

    expect(second.manifest.prefix).toBe("fix-signup");
    expect({ ...second.manifest, prefix: first.manifest.prefix }).toStrictEqual(first.manifest);
    expect(second.nodeFiles.map((file) => file.path)).toEqual(
      first.nodeFiles.map((file) => file.path),
    );
    expect(
      second.nodeFiles.map((file) => file.content.replaceAll("fix-signup", "fix-login")),
    ).toEqual(first.nodeFiles.map((file) => file.content));
    expect(second.nodeFiles.map((file) => file.content)).not.toEqual(
      first.nodeFiles.map((file) => file.content),
    );
  });

  it("fills the build's values into the agent files", () => {
    const input = flow(
      [agent("p", { settings: { instructions: "Fix {{ticket}}" } }), agent("a")],
      [thenWire("p", "a")],
    );
    input.session.buildConfig.variables = [{ name: "ticket", kind: "text" }];

    const files = Object.fromEntries(
      lower(input, { ...workspace, values: { ticket: "FD-99" } }).nodeFiles.map(
        ({ path, content }) => [path, content],
      ),
    );

    const filled = files["plugin/agents/p.md"] ?? "";
    expect(filled).toContain("Fix FD-99");
    expect(filled).not.toContain("{{ticket}}");
  });

  it("compiles one file per agent node, with its piece and this build's scope, and none for the rest", () => {
    const input = sample();

    expect(lower(input, workspace).nodeFiles).toStrictEqual([
      compileAgent(nodeOf(input, "p", "agent"), { piece: "p", scope }),
      compileAgent(nodeOf(input, "a", "agent"), { piece: "a", scope }),
      compileAgent(nodeOf(input, "x", "agent"), { piece: "x", scope }),
    ]);
  });

  describe("File wires", () => {
    const handoff = () =>
      flow(
        [agent("plan"), agent("build"), agent("check")],
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

      const plan = files["plugin/agents/plan.md"] ?? "";
      const check = files["plugin/agents/check.md"] ?? "";
      expect(sectionOf(plan, /^## Output$/)).toContain("plan.md");
      expect(sectionOf(plan, /^## Inputs$/)).not.toContain("plan.md");
      expect(files["plugin/agents/build.md"]).toContain("You are given: plan.md\n");
      expect(files["plugin/agents/build.md"]).toContain("Write: diff.md\n");
      expect(sectionOf(check, /^## Inputs$/)).toMatch(/plan\.md[\s\S]*diff\.md/);
      expect(sectionOf(check, /^## Output$/)).not.toMatch(/plan\.md|diff\.md/);
    });
  });

  it("ignores node positions", () => {
    const moved = sample();
    moved.nodes = moved.nodes.map((node, i) => ({ ...node, position: { x: i * 100, y: 7 } }));

    expect(lower(moved, workspace)).toStrictEqual(lower(sample(), workspace));
  });
});
