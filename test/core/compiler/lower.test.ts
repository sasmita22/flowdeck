import { describe, expect, it } from "vitest";
import { lower } from "../../../src/core/compiler/lower.js";
import { pieceNames } from "../../../src/core/compiler/pieces.js";
import { validate } from "../../../src/core/compiler/validate.js";
import type { Flow } from "../../../src/core/flow/schema.js";
import { compileAgent } from "../../../src/core/nodes/agent/compile.js";
import { sectionOf } from "../../fixtures/frontmatter.js";
import { oneSession } from "../../fixtures/one-session.js";
import {
  agent,
  flow,
  flowSettings,
  loop,
  output,
  sessionContainer,
  sessionsWorkflow,
  thenWire,
  trigger,
  twoSessionWorkflow,
  workspaceContainer,
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

const scope = { build: "fix-login-main", repo: "repo", workspace: "/fd-home/workspaces/b1" };

const sessionNodes = (input: Flow) => oneSession(lower(input, workspace).manifest).nodes;

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
    expect(sessionNodes(sample()).map((node) => node.id)).toEqual([
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
    const entries = sessionNodes(input);

    expect(entries.find((node) => node.id === "p")).toStrictEqual({
      id: "p",
      type: "agent",
      label: "p",
      settings: nodeOf(input, "p", "agent").settings,
      file: "sessions/main/plugin/agents/p.md",
      piece: "p",
    });
    expect(entries.find((node) => node.id === "a")).toStrictEqual({
      id: "a",
      type: "agent",
      label: "a",
      settings: nodeOf(input, "a", "agent").settings,
      file: "sessions/main/plugin/agents/a.md",
      piece: "a",
    });
    expect(entries.find((node) => node.id === "x")).toStrictEqual({
      id: "x",
      type: "agent",
      label: "x",
      parent: "L",
      settings: nodeOf(input, "x", "agent").settings,
      file: "sessions/main/plugin/agents/x.md",
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

    const named = sessionNodes(input).map(({ id, piece, file }) => ({
      id,
      piece,
      file,
    }));

    expect(named).toStrictEqual([
      { id: "start", piece: undefined, file: undefined },
      {
        id: "p1",
        piece: pieces.get("p1"),
        file: `sessions/main/plugin/agents/${pieces.get("p1")}.md`,
      },
      {
        id: "a1",
        piece: pieces.get("a1"),
        file: `sessions/main/plugin/agents/${pieces.get("a1")}.md`,
      },
      {
        id: "p2",
        piece: pieces.get("p2"),
        file: `sessions/main/plugin/agents/${pieces.get("p2")}.md`,
      },
      {
        id: "a2",
        piece: pieces.get("a2"),
        file: `sessions/main/plugin/agents/${pieces.get("a2")}.md`,
      },
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

  it("carries version 1 and the session's wires, and no hash", () => {
    const { manifest } = lower(sample(), workspace);

    expect(manifest.version).toBe(1);
    expect(oneSession(manifest).wires).toStrictEqual([
      thenWire("start", "p"),
      thenWire("p", "a"),
      thenWire("a", "x"),
      thenWire("x", "done"),
    ]);
    expect(manifest).not.toHaveProperty("hash");
  });

  describe("the session container", () => {
    const bridged = () =>
      flow(
        [
          trigger("workspace-start"),
          output("workspace-stop"),
          trigger("start"),
          agent("p"),
          loop("L"),
          agent("x", { parent: "L" }),
          output("done"),
        ],
        [
          thenWire("workspace-start", "workspace-stop"),
          thenWire("start", "p"),
          thenWire("p", "L"),
          thenWire("L", "done"),
        ],
        flowSettings,
        {
          containers: [
            workspaceContainer(["workspace-start", "workspace-stop"]),
            sessionContainer(["start", "p", "L", "done"], {
              name: "review",
              repo: "/r",
              branch: "release",
              model: "opus",
            }),
          ],
        },
      );

    it("carries its name, repo, branch as the base, and model on its manifest container", () => {
      const session = lower(bridged(), workspace).manifest.containers.find(
        (container) => container.kind === "session",
      );

      expect(session).toMatchObject({ name: "review", repo: "/r", base: "release", model: "opus" });
    });

    it("compiles only its members and their body nodes, leaving the workspace's Start and Stop out", () => {
      expect(sessionNodes(bridged()).map((node) => node.id)).toEqual([
        "start",
        "p",
        "L",
        "x",
        "done",
      ]);
    });

    it("gives the build its own Start as the one trigger", () => {
      expect(
        sessionNodes(bridged())
          .filter((node) => node.type === "trigger")
          .map((node) => node.id),
      ).toEqual(["start"]);
    });
  });

  it("carries the blueprint's settings into the manifest", () => {
    expect(lower(sample(), workspace).manifest.settings).toStrictEqual(flowSettings);

    const chosen = { buildModel: "opus", permissionMode: "acceptEdits" };
    const input = flow([trigger("start"), agent("p")], [thenWire("start", "p")], chosen);

    expect(lower(input, workspace).manifest.settings).toStrictEqual(chosen);
  });

  it("records the build name and session slug as the prefix, the workspace layout and the build's values", () => {
    const { manifest } = lower(sample(), {
      ...workspace,
      name: "fix-login",
      values: { ticket: "FD-99", "proceed-e2e": true },
    });

    expect(oneSession(manifest).prefix).toBe("fix-login-main");
    expect(manifest.layout).toBe("workspace");
    expect(manifest.values).toStrictEqual({ ticket: "FD-99", "proceed-e2e": true });
    expect(manifest).not.toHaveProperty("inputs");
  });

  it("lowers one flow under two build names to manifests that differ only in their prefix, and files that differ only in the build named", () => {
    const first = lower(sample(), workspace);
    const second = lower(sample(), { ...workspace, name: "fix-signup" });

    expect(oneSession(second.manifest).prefix).toBe("fix-signup-main");
    expect(
      JSON.parse(JSON.stringify(second.manifest).replaceAll("fix-signup", "fix-login")),
    ).toStrictEqual(JSON.parse(JSON.stringify(first.manifest)));
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

    const files = Object.fromEntries(
      lower(input, { ...workspace, values: { ticket: "FD-99" } }).nodeFiles.map(
        ({ path, content }) => [path, content],
      ),
    );

    const filled = files["sessions/main/plugin/agents/p.md"] ?? "";
    expect(filled).toContain("Fix FD-99");
    expect(filled).not.toContain("{{ticket}}");
  });

  it("compiles one file per agent node, with its piece and this build's scope, and none for the rest", () => {
    const input = sample();

    expect(lower(input, workspace).nodeFiles).toStrictEqual(
      [
        compileAgent(nodeOf(input, "p", "agent"), { piece: "p", scope }),
        compileAgent(nodeOf(input, "a", "agent"), { piece: "a", scope }),
        compileAgent(nodeOf(input, "x", "agent"), { piece: "x", scope }),
      ].map((file) => ({ ...file, path: `sessions/main/${file.path}` })),
    );
  });

  describe("hand-off files", () => {
    const handoff = () =>
      flow(
        [
          agent("plan", { settings: { writes: ["plan.md"] } }),
          agent("build", { settings: { given: ["plan.md"], writes: ["diff.md"] } }),
          agent("check", { settings: { given: ["plan.md", "diff.md"] } }),
        ],
        [thenWire("plan", "build"), thenWire("build", "check")],
      );

    it("carries only the flow's Then wires in the manifest", () => {
      const input = handoff();

      expect(oneSession(lower(input, workspace).manifest).wires).toStrictEqual([
        thenWire("plan", "build"),
        thenWire("build", "check"),
      ]);
    });

    it("tells each producer what to write and each consumer what it is given", () => {
      const files = Object.fromEntries(
        lower(handoff(), workspace).nodeFiles.map(({ path, content }) => [path, content]),
      );

      const plan = files["sessions/main/plugin/agents/plan.md"] ?? "";
      const check = files["sessions/main/plugin/agents/check.md"] ?? "";
      expect(sectionOf(plan, /^## Output$/)).toContain("plan.md");
      expect(sectionOf(plan, /^## Inputs$/)).not.toContain("plan.md");
      expect(files["sessions/main/plugin/agents/build.md"]).toContain("You are given: plan.md\n");
      expect(files["sessions/main/plugin/agents/build.md"]).toContain("Write: diff.md\n");
      expect(sectionOf(check, /^## Inputs$/)).toMatch(/plan\.md[\s\S]*diff\.md/);
      expect(sectionOf(check, /^## Output$/)).not.toMatch(/plan\.md|diff\.md/);
    });
  });

  it("ignores node positions", () => {
    const moved = sample();
    moved.nodes = moved.nodes.map((node, i) => ({ ...node, position: { x: i * 100, y: 7 } }));

    expect(lower(moved, workspace)).toStrictEqual(lower(sample(), workspace));
  });

  describe("per container", () => {
    const containersOf = (input: Flow) => lower(input, workspace).manifest.containers ?? [];

    const named = (input: Flow, nodeId: string) => {
      const container = containersOf(input).find((candidate) =>
        candidate.nodes.some((node) => node.id === nodeId),
      );
      const node = container?.nodes.find((candidate) => candidate.id === nodeId);
      return `${container?.prefix ?? ""}:${node?.piece ?? ""}`;
    };

    it("lowers one set for the workspace and one for each session container", () => {
      expect(containersOf(twoSessionWorkflow()).map(({ kind, slug }) => ({ kind, slug }))).toEqual([
        { kind: "workspace", slug: "workspace" },
        { kind: "session", slug: "android" },
        { kind: "session", slug: "ios" },
      ]);
    });

    it("prefixes each container with the build name and its slug", () => {
      expect(containersOf(twoSessionWorkflow()).map((container) => container.prefix)).toEqual([
        "fix-login-workspace",
        "fix-login-android",
        "fix-login-ios",
      ]);
    });

    it("names a Plan in android and a Plan in ios apart", () => {
      const input = twoSessionWorkflow();

      expect(named(input, "session-1-plan")).toBe("fix-login-android:plan");
      expect(named(input, "session-2-plan")).toBe("fix-login-ios:plan");
    });

    it("lowers the workspace's own members into the workspace, named apart from a session's", () => {
      const input = sessionsWorkflow(
        [{ name: "android", repo: "/repos/android", branch: "main" }],
        { workspace: ["Plan"] },
      );

      expect(named(input, "workspace-1-plan")).toBe("fix-login-workspace:plan");
      expect(named(input, "session-1-plan")).toBe("fix-login-android:plan");
    });

    it.each([
      [
        "one session",
        sessionsWorkflow([{ name: "android", repo: "/repos/android", branch: "main" }]),
      ],
      ["two sessions", twoSessionWorkflow()],
    ])(
      "keeps nodes, wires and prefix only on the containers, the workspace's included, for %s",
      (_label, input) => {
        const { manifest } = lower(input, workspace);

        for (const field of ["nodes", "wires", "prefix", "session"]) {
          expect(manifest, field).not.toHaveProperty(field);
        }
        for (const container of manifest.containers) {
          expect(container.nodes.length, container.slug).toBeGreaterThan(0);
          expect(container.wires.length, container.slug).toBeGreaterThan(0);
          expect(container.prefix, container.slug).toBe(`fix-login-${container.slug}`);
        }
        expect(manifest.containers[0]?.kind).toBe("workspace");
      },
    );

    it("holds only each container's own nodes, in run order, and the wires between them", () => {
      const sets = containersOf(twoSessionWorkflow()).map((container) => ({
        nodes: container.nodes.map((node) => node.id),
        wires: container.wires.map((wire) => `${wire.from.node}>${wire.to.node}`),
      }));

      expect(sets).toEqual([
        {
          nodes: ["workspace-1-start", "workspace-1-stop"],
          wires: ["workspace-1-start>workspace-1-stop"],
        },
        {
          nodes: ["session-1-start", "session-1-plan", "session-1-stop"],
          wires: ["session-1-start>session-1-plan", "session-1-plan>session-1-stop"],
        },
        {
          nodes: ["session-2-start", "session-2-plan", "session-2-stop"],
          wires: ["session-2-start>session-2-plan", "session-2-plan>session-2-stop"],
        },
      ]);
    });
  });

  describe("connections", () => {
    const android = "session-1";
    const ios = "session-2";
    const web = "session-3";

    const threeSessions = (androidName = "android"): Flow =>
      sessionsWorkflow([
        { name: androidName, repo: "/repos/android", branch: "main" },
        { name: "ios", repo: "/repos/ios", branch: "main" },
        { name: "web", repo: "/repos/web", branch: "main" },
      ]);

    const connectionsOf = (input: Flow, ...pairs: [string, string][]) =>
      lower(
        { ...input, connections: pairs.map((between, index) => ({ id: `c${index}`, between })) },
        workspace,
      ).manifest;

    it("carries each connection as a pair of session slugs", () => {
      expect(connectionsOf(threeSessions(), [android, ios]).connections).toEqual([
        ["android", "ios"],
      ]);
    });

    it("names a renamed session by its new slug", () => {
      expect(connectionsOf(threeSessions("Droid App"), [android, ios]).connections).toEqual([
        ["droid-app", "ios"],
      ]);
    });

    it("sorts each pair and the list", () => {
      expect(connectionsOf(threeSessions(), [web, ios], [ios, android]).connections).toEqual([
        ["android", "ios"],
        ["ios", "web"],
      ]);
    });

    it("leaves the connections key out when there are none", () => {
      expect(connectionsOf(threeSessions())).not.toHaveProperty("connections");
      expect(lower(threeSessions(), workspace).manifest).not.toHaveProperty("connections");
    });
  });
});
