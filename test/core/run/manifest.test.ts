import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../../src/core/compiler/canonical-json.js";
import { emit } from "../../../src/core/compiler/emit.js";
import { lower, type Manifest } from "../../../src/core/compiler/lower.js";
import type { Flow } from "../../../src/core/flow/schema.js";
import { parseManifest, singleSession, stageSourcesOf } from "../../../src/core/run/manifest.js";
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
  it("reads a named build's manifest with its session's prefix and the workspace layout", () => {
    const manifest = parseManifest(manifestText(gates()), named);

    expect(manifest.nodes.map((node) => node.id)).toEqual(["start", "write", "check", "stop"]);
    expect(manifest.prefix).toBe("fix-login-main");
    expect(manifest.layout).toBe("workspace");
  });

  it("gives an old build without a prefix the build hash as its prefix, in the legacy layout", () => {
    const manifest = parseManifest(legacyText(gates()), legacy);

    expect(manifest.prefix).toBe(hash);
    expect(manifest.layout).toBe("legacy");
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
      [thenWire("plan", "review"), thenWire("review", "each")],
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

const manifestWith = (containers: Record<string, unknown>[]) => {
  const sessions = containers.filter((container) => container.kind === "session");
  const only = sessions.length === 1 ? sessions[0] : undefined;
  return canonicalJson({
    version: 1,
    hash,
    files: {},
    containers,
    ...(only === undefined
      ? {}
      : {
          session: { name: only.name, model: only.model, buildConfig: {} },
          prefix: only.prefix,
          layout: "workspace",
          nodes: only.nodes,
          wires: only.wires,
        }),
  });
};

describe("parseManifest with containers", () => {
  it("keeps every container of a two-session build that has no top-level session", () => {
    const manifest = parseManifest(manifestWith([workspaceEntry(), android, ios]), named);

    expect(manifest.containers?.map((container) => container.slug)).toEqual([
      "workspace",
      "android",
      "ios",
    ]);
    expect(manifest.session).toBeUndefined();
  });

  it("reads a build with no session container", () => {
    const manifest = parseManifest(manifestWith([workspaceEntry()]), named);

    expect(manifest.containers?.map((container) => container.kind)).toEqual(["workspace"]);
  });

  it("keeps each session container's repo, base, branch, worktree and model", () => {
    const manifest = parseManifest(manifestWith([workspaceEntry(), android, ios]), named);

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

describe("stageSourcesOf with containers", () => {
  it("takes every container's nodes and Then wires when there is no top-level session", () => {
    const manifest = parseManifest(manifestWith([workspaceEntry(), android, ios]), named);

    const sources = stageSourcesOf(manifest);

    expect(sources.nodes.map((node) => node.id)).toEqual([
      "workspace-start",
      "workspace-stop",
      "android-start",
      "android-plan",
      "android-stop",
      "ios-start",
      "ios-plan",
      "ios-stop",
    ]);
    expect(sources.wires.map((wire) => [wire.from.node, wire.to.node])).toEqual([
      ["workspace-start", "workspace-stop"],
      ["android-start", "android-plan"],
      ["android-plan", "android-stop"],
      ["ios-start", "ios-plan"],
      ["ios-plan", "ios-stop"],
    ]);
  });

  it("names the session workspace when there is no top-level session", () => {
    const manifest = parseManifest(manifestWith([workspaceEntry(), android, ios]), named);

    expect(stageSourcesOf(manifest).session).toEqual({ name: "workspace" });
  });
});

describe("singleSession", () => {
  const refusal = { ok: false, reason: "Running several sessions is not supported yet." };

  it("gives the session container of a one-session build whose workspace holds only Start and Stop", () => {
    const result = singleSession(parseManifest(manifestWith([workspaceEntry(), android]), named));

    expect(result).toEqual({ ok: true, container: expect.objectContaining({ slug: "android" }) });
  });

  it("refuses a build with two session containers", () => {
    expect(
      singleSession(parseManifest(manifestWith([workspaceEntry(), android, ios]), named)),
    ).toEqual(refusal);
  });

  it("refuses a build with no session container", () => {
    expect(singleSession(parseManifest(manifestWith([workspaceEntry()]), named))).toEqual(refusal);
  });

  it("refuses a one-session build whose workspace holds an Agent", () => {
    const workspace = workspaceEntry([{ id: "workspace-plan", type: "agent", label: "Plan" }]);

    expect(singleSession(parseManifest(manifestWith([workspace, android]), named))).toEqual(
      refusal,
    );
  });
});
