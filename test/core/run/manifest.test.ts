import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../../src/core/compiler/canonical-json.js";
import { emit } from "../../../src/core/compiler/emit.js";
import { lower, type Manifest } from "../../../src/core/compiler/lower.js";
import type { Flow } from "../../../src/core/flow/schema.js";
import {
  parseManifest,
  sessionContainersOf,
  stageSourcesOf,
  workspaceOf,
} from "../../../src/core/run/manifest.js";
import { agent, forEach, gate, loop, onMainFlow, thenWire } from "../../fixtures/flow-builders.js";

const hash = "a".repeat(64);

const manifestText = (flow: Flow): string => {
  const files = emit(lower(flow, { name: "fix-login", values: {} }), {
    repo: "/work/repo",
    base: "main",
    branch: "flowdeck/fix-login",
    branchCreated: true,
    workspace: "/fd/workspaces/b-login",
  });
  const manifest = files.find((file) => file.path === "manifest.json");
  if (manifest === undefined) throw new Error("emit wrote no manifest.json");
  return canonicalJson({ ...(JSON.parse(manifest.content) as object), hash });
};

const textWithoutLayout = (flow: Flow): string => {
  const manifest: Partial<Manifest> = JSON.parse(manifestText(flow)) as Manifest;
  delete manifest.layout;
  return canonicalJson(manifest);
};

const gates = () => onMainFlow([gate("write"), gate("check")], [thenWire("write", "check")]);

describe("parseManifest", () => {
  it("reads a build's manifest with its session's prefix", () => {
    const manifest = parseManifest(manifestText(gates()));
    const [session] = sessionContainersOf(manifest);

    expect(session?.nodes.map((node) => node.id)).toEqual(["start", "write", "check", "stop"]);
    expect(session?.prefix).toBe("fix-login-main");
  });

  it("adds no layout the manifest does not hold", () => {
    expect(parseManifest(textWithoutLayout(gates()))).not.toHaveProperty("layout");
  });

  it("refuses text that is not JSON", () => {
    expect(() => parseManifest("{not json")).toThrow();
  });

  it("refuses JSON that is not a manifest", () => {
    expect(() => parseManifest(JSON.stringify({ version: 1, hash }))).toThrow();
  });
});

describe("stageSourcesOf", () => {
  it("keeps each node's id, type, label and parent, and the Then wires in order, under its container", () => {
    const flow = onMainFlow(
      [agent("plan"), loop("review"), agent("fix", { parent: "review" }), forEach("each")],
      [thenWire("plan", "review"), thenWire("review", "each")],
    );
    const manifest = parseManifest(manifestText(flow));

    const [workspace, main, ...rest] = stageSourcesOf(manifest);

    expect(rest).toEqual([]);
    expect(workspace?.nodes.map((node) => node.id)).toEqual([
      "workspace-1-start",
      "workspace-1-stop",
    ]);
    expect(main?.name).toBe("main");
    expect(main?.nodes).toEqual([
      { id: "start", type: "trigger", label: "start" },
      { id: "plan", type: "agent", label: "plan" },
      { id: "review", type: "loop", label: "review" },
      { id: "fix", type: "agent", label: "fix", parent: "review" },
      { id: "each", type: "foreach", label: "each plan unit" },
      { id: "stop", type: "output", label: "stop" },
    ]);
    expect(main?.wires.map((wire) => [wire.from.node, wire.to.node])).toEqual([
      ["start", "plan"],
      ["plan", "review"],
      ["review", "each"],
      ["each", "stop"],
    ]);
  });
});

const dir = "/fd/builds/fix-login";
const settings = {};

const chain = (slug: string, middle: { id: string; type: string; label: string }[]) => {
  const nodes = [
    { id: `${slug}-start`, type: "trigger", label: "Start", settings },
    ...middle.map((node) => ({ ...node, settings })),
    { id: `${slug}-stop`, type: "output", label: "Stop", settings },
  ];
  return {
    nodes,
    wires: nodes.slice(1).map((node, index) => ({
      kind: "then",
      from: { node: nodes[index]?.id ?? "", port: "out" },
      to: { node: node.id, port: "in" },
    })),
  };
};

const workspaceEntry = (middle: { id: string; type: string; label: string }[] = []) => ({
  kind: "workspace",
  name: "workspace",
  slug: "workspace",
  prefix: "fix-login-workspace",
  model: "sonnet",
  ...chain("workspace", middle),
  orchestrator: "workspace/plugin/skills/run/SKILL.md",
});

const sessionEntry = (slug: string, repo: string, base: string) => ({
  kind: "session",
  name: slug,
  slug,
  prefix: `fix-login-${slug}`,
  repo,
  base,
  branch: `fd-${slug}`,
  worktree: `${dir}/sessions/${slug}/${slug}`,
  model: "sonnet",
  ...chain(slug, [{ id: `${slug}-plan`, type: "agent", label: "Plan" }]),
  orchestrator: `sessions/${slug}/plugin/skills/run/SKILL.md`,
});

const android = sessionEntry("android", "/repos/android", "main");
const ios = sessionEntry("ios", "/repos/ios", "develop");

const manifestWith = (containers: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  canonicalJson({ version: 1, hash, files: {}, containers, ...extra });

describe("parseManifest with containers", () => {
  it("keeps every container of a two-session build that has no top-level session", () => {
    const manifest = parseManifest(manifestWith([workspaceEntry(), android, ios]));

    expect(manifest.containers?.map((container) => container.slug)).toEqual([
      "workspace",
      "android",
      "ios",
    ]);
    expect("session" in manifest).toBe(false);
  });

  it("reads a build with no session container", () => {
    const manifest = parseManifest(manifestWith([workspaceEntry()]));

    expect(manifest.containers?.map((container) => container.kind)).toEqual(["workspace"]);
  });

  it("keeps each session container's repo, base, branch, worktree and model", () => {
    const manifest = parseManifest(manifestWith([workspaceEntry(), android, ios]));

    expect(
      manifest.containers?.map(({ slug, repo, base, branch, worktree, model }) => ({
        slug,
        repo,
        base,
        branch,
        worktree,
        model,
      })),
    ).toEqual([
      {
        slug: "workspace",
        repo: undefined,
        base: undefined,
        branch: undefined,
        worktree: undefined,
        model: "sonnet",
      },
      {
        slug: "android",
        repo: "/repos/android",
        base: "main",
        branch: "fd-android",
        worktree: `${dir}/sessions/android/android`,
        model: "sonnet",
      },
      {
        slug: "ios",
        repo: "/repos/ios",
        base: "develop",
        branch: "fd-ios",
        worktree: `${dir}/sessions/ios/ios`,
        model: "sonnet",
      },
    ]);
  });
});

describe("parseManifest with connections", () => {
  const containers = () => [workspaceEntry(), android, ios];

  it("keeps the connected slug pairs", () => {
    const manifest = parseManifest(
      manifestWith(containers(), { connections: [["android", "ios"]] }),
    );

    expect(manifest.connections).toEqual([["android", "ios"]]);
  });

  it("reads a manifest without connections as before, with no connections key", () => {
    expect(parseManifest(manifestWith(containers()))).not.toHaveProperty("connections");
  });

  it.each([
    ["a pair with one slug", [["android"]]],
    ["a pair with a number", [["android", 2]]],
    ["a list that is not pairs", ["android"]],
  ])("refuses connections with %s", (_label, connections) => {
    expect(() => parseManifest(manifestWith(containers(), { connections }))).toThrow();
  });
});

describe("stageSourcesOf with containers", () => {
  it("gives one group per container, workspace first, each with its name, its own nodes and Then wires", () => {
    const workspace = workspaceEntry([{ id: "workspace-plan", type: "agent", label: "Plan" }]);
    const manifest = parseManifest(manifestWith([workspace, android, ios]));

    const groups = stageSourcesOf(manifest);

    expect(
      groups.map(({ name, nodes, wires }) => ({
        name,
        nodes: nodes.map((node) => node.id),
        wires: wires.map((wire) => [wire.from.node, wire.to.node]),
      })),
    ).toEqual([
      {
        name: "workspace",
        nodes: ["workspace-start", "workspace-plan", "workspace-stop"],
        wires: [
          ["workspace-start", "workspace-plan"],
          ["workspace-plan", "workspace-stop"],
        ],
      },
      {
        name: "android",
        nodes: ["android-start", "android-plan", "android-stop"],
        wires: [
          ["android-start", "android-plan"],
          ["android-plan", "android-stop"],
        ],
      },
      {
        name: "ios",
        nodes: ["ios-start", "ios-plan", "ios-stop"],
        wires: [
          ["ios-start", "ios-plan"],
          ["ios-plan", "ios-stop"],
        ],
      },
    ]);
  });

  it("puts the workspace group first even when the workspace is not listed first", () => {
    const manifest = parseManifest(manifestWith([android, workspaceEntry(), ios]));

    expect(stageSourcesOf(manifest).map((group) => group.name)).toEqual([
      "workspace",
      "android",
      "ios",
    ]);
  });
});

describe("workspaceOf", () => {
  it("gives the workspace container's own nodes, wires, prefix and model", () => {
    const workspace = {
      ...workspaceEntry([{ id: "workspace-plan", type: "agent", label: "Plan" }]),
      model: "opus",
    };
    const manifest = parseManifest(manifestWith([android, workspace, ios]));

    const view = workspaceOf(manifest);

    expect(view.nodes.map((node) => node.id)).toEqual([
      "workspace-start",
      "workspace-plan",
      "workspace-stop",
    ]);
    expect(view.wires).toEqual(workspace.wires);
    expect(view.prefix).toBe("fix-login-workspace");
    expect(view.model).toBe("opus");
  });
});

describe("sessionContainersOf", () => {
  it("gives the session containers in the manifest's order, without the workspace", () => {
    const manifest = parseManifest(manifestWith([workspaceEntry(), ios, android]));

    expect(sessionContainersOf(manifest).map((container) => container.slug)).toEqual([
      "ios",
      "android",
    ]);
  });

  it("gives none for a build with only the workspace", () => {
    expect(sessionContainersOf(parseManifest(manifestWith([workspaceEntry()])))).toEqual([]);
  });
});
