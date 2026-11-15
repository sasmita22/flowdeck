import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../../src/core/compiler/canonical-json.js";
import { emit } from "../../../src/core/compiler/emit.js";
import { lower, type Manifest } from "../../../src/core/compiler/lower.js";
import type { Flow } from "../../../src/core/flow/schema.js";
import { handoffPairs } from "../../../src/core/flow/handoff.js";
import { parseManifest, stageSourcesOf } from "../../../src/core/run/manifest.js";
import {
  agent,
  fileWire,
  forEach,
  gate,
  loop,
  onMainFlow,
  thenWire,
} from "../../fixtures/flow-builders.js";

const hash = "a".repeat(64);

const manifestText = (flow: Flow): string => {
  const files = emit(lower(flow, { name: "fix-login", values: {} }), {
    repo: "/work/repo",
    base: "main",
    branch: "flowdeck/fix-login",
    branchCreated: true,
  });
  const manifest = files.find((file) => file.path === "manifest.json");
  if (manifest === undefined) throw new Error("emit wrote no manifest.json");
  return canonicalJson({ ...(JSON.parse(manifest.content) as object), hash });
};

const legacyText = (flow: Flow): string => {
  const manifest: Partial<Manifest> = JSON.parse(manifestText(flow)) as Manifest;
  delete manifest.prefix;
  delete manifest.layout;
  return canonicalJson(manifest);
};

const gates = () => onMainFlow([gate("write"), gate("check")], [thenWire("write", "check")]);

const named = { hash, name: "fix-login" };
const legacy = { hash, name: null };

describe("parseManifest", () => {
  it("reads a named build's manifest with its own prefix and the workspace layout", () => {
    const manifest = parseManifest(manifestText(gates()), named);

    expect(manifest.nodes.map((node) => node.id)).toEqual(["start", "write", "check", "stop"]);
    expect(manifest.prefix).toBe("fix-login");
    expect(manifest.layout).toBe("workspace");
  });

  it("gives an old build without a prefix the build hash as its prefix, in the legacy layout", () => {
    const manifest = parseManifest(legacyText(gates()), legacy);

    expect(manifest.prefix).toBe(hash);
    expect(manifest.layout).toBe("legacy");
  });

  it("turns an old build's File wire into its agents' settings, keeping only Then wires", () => {
    const text = legacyText(
      onMainFlow(
        [agent("plan"), agent("build")],
        [thenWire("plan", "build"), fileWire("plan", "build", "plan.md")],
      ),
    );

    const manifest = parseManifest(text, legacy);

    expect(handoffPairs(manifest.nodes)).toEqual([
      { file: "plan.md", reader: "build", writers: ["plan"] },
    ]);
    expect(manifest.wires.every((wire) => wire.kind === "then")).toBe(true);
  });

  it("refuses text that is not JSON", () => {
    expect(() => parseManifest("{not json", named)).toThrow();
  });

  it("refuses JSON that is not a manifest", () => {
    expect(() => parseManifest(JSON.stringify({ version: 1, hash }), named)).toThrow();
  });
});

describe("stageSourcesOf", () => {
  it("keeps the session name, each node's id, type, label and parent, and the Then wires in order", () => {
    const flow = onMainFlow(
      [agent("plan"), loop("review"), agent("fix", { parent: "review" }), forEach("each")],
      [thenWire("plan", "review"), thenWire("review", "each"), fileWire("plan", "fix", "plan.md")],
    );
    const manifest = parseManifest(manifestText(flow), named);

    const sources = stageSourcesOf(manifest);

    expect(sources.session).toEqual({ name: "main" });
    expect(sources.nodes).toEqual([
      { id: "start", type: "trigger", label: "start" },
      { id: "plan", type: "agent", label: "plan" },
      { id: "review", type: "loop", label: "review" },
      { id: "fix", type: "agent", label: "fix", parent: "review" },
      { id: "each", type: "foreach", label: "each plan unit" },
      { id: "stop", type: "output", label: "stop" },
    ]);
    expect(sources.wires).toEqual(manifest.wires.filter((wire) => wire.kind === "then"));
    expect(sources.wires.map((wire) => [wire.from.node, wire.to.node])).toEqual([
      ["start", "plan"],
      ["plan", "review"],
      ["review", "each"],
      ["each", "stop"],
    ]);
  });
});
