import { describe, expect, it } from "vitest";
import { lower } from "../../../src/core/compiler/lower.js";
import { orchestratorPath, orchestratorSkill } from "../../../src/core/compiler/orchestrator.js";
import { pieceNames } from "../../../src/core/compiler/pieces.js";
import { scopeLine } from "../../../src/core/compiler/scope-line.js";
import { order } from "../../../src/core/flow/order.js";
import type { Flow } from "../../../src/core/flow/schema.js";
import {
  agent,
  ask,
  branch,
  flow,
  fork,
  gate,
  hardstop,
  join,
  loop,
  output,
  thenWire,
  trigger,
  twoSessionWorkflow,
  wire,
} from "../../fixtures/flow-builders.js";
import { expectBareHandoffRule, nestedHandoffPaths } from "../../fixtures/handoff.js";

const scope = { build: "fix-login", repo: "carousell-web", workspace: "/fd/workspaces/b1" };

const labelled = <T extends { label: string }>(node: T, label: string): T => ({ ...node, label });

const sample = (): Flow =>
  flow(
    [
      trigger("t"),
      labelled(agent("p", { settings: { instructions: "Plan it." } }), "Plan"),
      labelled(agent("a", { settings: { given: ["plan.md"], writes: ["code.md"] } }), "Code"),
      gate("g", { settings: { shown: "Check the plan", skippable: false } }),
      ask("k", { settings: { question: "Pick a colour", options: ["red", "blue"] } }),
      loop("l", { settings: { condition: "tests pass", cap: 4, onCap: "ask" } }),
      labelled(agent("la", { parent: "l" }), "Fix"),
      branch("b", "proceed"),
      fork("f"),
      labelled(agent("x"), "Check"),
      labelled(agent("y"), "Check"),
      join("j", { settings: { wait: "first" } }),
      hardstop("h", { settings: { condition: "tests fail", shown: "report" } }),
      output("o"),
    ],
    [
      thenWire("t", "p"),
      thenWire("p", "a"),
      thenWire("a", "g"),
      thenWire("g", "k"),
      thenWire("k", "l"),
      thenWire("l", "la"),
      thenWire("l", "b"),
      wire("b", "yes", "f", "in"),
      wire("b", "no", "h", "in"),
      thenWire("f", "x"),
      thenWire("f", "y"),
      thenWire("x", "j"),
      thenWire("y", "j"),
      thenWire("j", "o"),
      thenWire("h", "o"),
    ],
  );

const manifestOf = (input: Flow) => {
  const { manifest } = lower(input, { name: scope.build, values: {} });
  const session = manifest.containers.find((container) => container.kind === "session");
  if (session === undefined) throw new Error("the flow has no session container");
  const pieces = pieceNames(input);
  return {
    ...session,
    nodes: session.nodes.map((node) => {
      const piece = pieces.get(node.id);
      return piece === undefined ? node : { ...node, piece };
    }),
  };
};

const skill = (input: Flow = sample()) => orchestratorSkill(manifestOf(input), scope);

const frontmatter = (content: string) => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
  expect(match).not.toBeNull();
  return Object.fromEntries(
    (match?.[1] ?? "").split("\n").map((line) => {
      const at = line.indexOf(": ");
      return [line.slice(0, at), JSON.parse(line.slice(at + 2)) as unknown];
    }),
  );
};

const stepLines = (content: string) => content.split("\n").filter((line) => /^\d+\. /.test(line));

const lineOf = (content: string, nodeId: string) =>
  stepLines(content).find((line) => line.includes(`NODE ${nodeId} `)) ?? "";

describe("orchestratorSkill", () => {
  it("writes the session's plugin/skills/run/SKILL.md named run, its description opening with the scope line", () => {
    const { path, content } = skill();
    const fields = frontmatter(content);

    expect(path).toBe("sessions/main/plugin/skills/run/SKILL.md");
    expect(fields.name).toBe("run");
    expect(String(fields.description).startsWith(scopeLine(scope))).toBe(true);
  });

  it("says in its description that a Flowdeck run's start command types it, not only a person without the app", () => {
    const description = String(frontmatter(skill().content).description);

    expect(description).toContain("by a Flowdeck run's start command");
    expect(description).not.toContain("without the Flowdeck app");
  });

  it("lists every node of the session once, in the order the runner uses, each with its node marker", () => {
    const ids = stepLines(skill().content).map((line) => /NODE (\S+) /.exec(line)?.[1]);

    expect(ids).toEqual(
      order(sample()).filter((id) => !id.startsWith("workspace-") && !id.startsWith("canvas-")),
    );
    expect(ids).toEqual(manifestOf(sample()).nodes.map((node) => node.id));
  });

  it("says hand-off files are named bare in the run's working folder, which sits at the repo folder in this session's own folder", () => {
    const { content } = skill();
    const body = content.slice(content.indexOf("\n---\n") + 5);

    expectBareHandoffRule(body, "carousell-web");
    expect(
      nestedHandoffPaths(content, "carousell-web", ["plan.md", "code.md", "units.md"]),
    ).toEqual([]);
  });

  it("hands work only to agents: no step reads a skill or runs a command, and no line names a Prompt", () => {
    const { content } = skill();

    expect(lineOf(content, "p")).toContain("dispatch `fix-login-main:plan`");
    expect(content).not.toMatch(/by path and follow it|check its exit code|Prompt/);
  });

  it("dispatches an Agent node by its full name with its node marker and details, and waits", () => {
    const line = lineOf(skill().content, "a");

    expect(line).toContain("dispatch `fix-login-main:code`");
    expect(line).toContain(JSON.stringify("NODE a\nYou are given: plan.md\nWrite: code.md\nGo"));
    expect(line).toContain("wait");
  });

  it("dispatches a writer and its reader each with the files they hand on, each file once", () => {
    const paired = flow(
      [
        labelled(
          agent("a", { settings: { given: ["plan.md"], writes: ["code.md", "code.md"] } }),
          "Code",
        ),
        labelled(agent("p", { settings: { given: ["code.md"] } }), "Ship"),
      ],
      [thenWire("a", "p")],
    );

    expect(lineOf(skill(paired).content, "a")).toContain(
      JSON.stringify("NODE a\nYou are given: plan.md\nWrite: code.md\nGo"),
    );
    expect(lineOf(skill(paired).content, "p")).toContain(
      JSON.stringify("NODE p\nYou are given: code.md\nGo"),
    );
  });

  it("asks in the chat for a Gate and an Ask", () => {
    expect(lineOf(skill().content, "g")).toMatch(/ask in the chat.*Check the plan/i);
    expect(lineOf(skill().content, "k")).toMatch(/ask in the chat.*Pick a colour.*red, blue/i);
  });

  it("repeats a Loop up to its cap", () => {
    const content = skill().content;

    expect(lineOf(content, "l")).toMatch(/repeat.*NODE la.*tests pass.*at most 4 rounds/);
  });

  it("reads a Branch's variable from the build summary and names both ways", () => {
    expect(lineOf(skill().content, "b")).toMatch(
      /proceed.*build summary.*yes.*NODE f.*no.*NODE h/i,
    );
  });

  it("reads a value-decided Branch's answer from the Agent that produced it, asking rather than guessing", () => {
    const line = lineOf(
      skill(
        flow(
          [
            trigger("t"),
            labelled(agent("c", { settings: { produces: "tests-passed" } }), "Check"),
            {
              ...branch("b", ""),
              settings: { variable: "", decidedBy: "value", value: "tests-passed" },
            },
            labelled(agent("y"), "Ship"),
            labelled(agent("n"), "Fix"),
            output("o"),
          ],
          [
            thenWire("t", "c"),
            thenWire("c", "b"),
            wire("b", "yes", "y", "in"),
            wire("b", "no", "n", "in"),
            thenWire("y", "o"),
            thenWire("n", "o"),
          ],
        ),
      ).content,
      "b",
    );

    expect(line).toMatch(/tests-passed.*NODE c/);
    expect(line).not.toMatch(/build summary/i);
    expect(line).toMatch(/missing|malformed|unreadable/i);
    expect(line).toMatch(/ask/i);
    expect(line).toMatch(/guess/i);
    expect(line).toMatch(/yes.*NODE y.*no.*NODE n/);
  });

  it("asks an Agent that produces a value for its json answer in its dispatch prompt", () => {
    const line = lineOf(
      skill(
        flow(
          [trigger("t"), labelled(agent("c", { settings: { produces: "tests-passed" } }), "Check")],
          [thenWire("t", "c")],
        ),
      ).content,
      "c",
    );

    expect(line).toMatch(/fenced code block tagged json/);
    expect(line).toContain('\\"tests-passed\\": true');
    expect(line).toContain('\\"tests-passed\\": false');
  });

  it("dispatches every Fork branch agent by full name in one message", () => {
    const line = lineOf(skill().content, "f");

    expect(line).toMatch(/one message/);
    expect(line).toContain("`fix-login-main:check`");
    expect(line).toContain("`fix-login-main:check-2`");
    expect(line).toContain(JSON.stringify("NODE x\nGo"));
    expect(line).toContain(JSON.stringify("NODE y\nGo"));
  });

  it("states the join mode", () => {
    const firstJoin = lineOf(skill().content, "j");
    const allFlow = sample();
    const allJoin = lineOf(
      skill({
        ...allFlow,
        nodes: allFlow.nodes.map((node) =>
          node.type === "join" ? { ...node, settings: { ...node.settings, wait: "all" } } : node,
        ),
      }).content,
      "j",
    );

    expect(firstJoin).toMatch(/first.*others are ignored/i);
    expect(allJoin).toMatch(/every branch has returned/i);
  });

  it("states a hard stop as a hard rule", () => {
    expect(lineOf(skill().content, "h")).toMatch(/hard rule.*tests fail/i);
  });

  it("tells a hard stop to end its reply with the line naming its node", () => {
    expect(lineOf(skill().content, "h")).toContain(
      "show report, end your reply with the line `STOPPED NODE h` and end your turn.",
    );
  });

  it("tells a Loop that fails at its cap to end its reply with the line naming its node, and one that asks not to", () => {
    const failing = sample();
    const failingLoop = lineOf(
      skill({
        ...failing,
        nodes: failing.nodes.map((node) =>
          node.type === "loop" ? { ...node, settings: { ...node.settings, onCap: "fail" } } : node,
        ),
      }).content,
      "l",
    );

    expect(failingLoop).toContain(
      "at the cap, stop the run as failed: end your reply with the line `STOPPED NODE l` and end your turn.",
    );
    expect(lineOf(skill().content, "l")).not.toContain("STOPPED NODE");
  });

  it("states a Stop's output as the run's result handed back to the user, not a file a step writes", () => {
    const stopped = flow(
      [
        trigger("t"),
        labelled(output("o", { settings: { name: "summary", type: "markdown" } }), "Done"),
      ],
      [thenWire("t", "o")],
    );
    const line = lineOf(skill(stopped).content, "o");

    expect(line).toMatch(/^\d+\. NODE o \(Done\): /);
    expect(line).toContain("the run ends here");
    expect(line).toContain("`summary` (markdown)");
    expect(line).toContain("handed back to the user");
    expect(line).toContain("not a file any step writes");
    expect(line).not.toContain("is ready");
  });

  it("refuses a library node, which is expanded before the build", () => {
    const manifest = {
      prefix: "fix-login",
      orchestrator: "run",
      wires: [],
      nodes: [
        {
          id: "lib",
          type: "library" as const,
          label: "android-app",
          settings: { libraryId: "lib-1", label: "android-app", overrides: {} },
        },
      ],
    };

    expect(() => orchestratorSkill(manifest, scope)).toThrow(
      "library nodes are expanded before the build",
    );
  });

  it("changes when a wire changes, and is the same for the same flow", () => {
    const base = sample();
    const rewired = {
      ...base,
      wires: base.wires.map((item) =>
        item.kind === "then" && item.from.node === "b" && item.from.port === "yes"
          ? { ...item, to: { node: "h", port: "in" } }
          : item.kind === "then" && item.from.node === "b" && item.from.port === "no"
            ? { ...item, to: { node: "f", port: "in" } }
            : item,
      ),
    };

    expect(skill()).toStrictEqual(skill());
    expect(skill(rewired).content).not.toBe(skill().content);
  });

  it("names every agent and skill with this build's prefix", () => {
    const named = [...skill().content.matchAll(/`([a-z0-9-]+):([a-z0-9-]+)`/g)];

    expect(named.length).toBeGreaterThan(0);
    for (const [, prefix] of named) expect(prefix).toBe("fix-login-main");
  });
});

describe("an orchestrator per container", () => {
  const containers = () =>
    lower(twoSessionWorkflow(), { name: "fix-login", values: {} }).manifest.containers ?? [];

  const rootOf = (container: { kind: string; slug: string }) =>
    container.kind === "workspace" ? "workspace" : `sessions/${container.slug}`;

  const markers = (content: string) =>
    content.split("\n").flatMap((line) => /^\d+\. NODE (\S+) /.exec(line)?.[1] ?? []);

  it("places the orchestrator under the container root it is given", () => {
    expect(orchestratorPath("workspace")).toBe("workspace/plugin/skills/run/SKILL.md");
    expect(orchestratorPath("sessions/ios")).toBe("sessions/ios/plugin/skills/run/SKILL.md");
  });

  it("writes one orchestrator per container, each at its own root", () => {
    const paths = containers().map((container) => orchestratorSkill(container, scope).path);

    expect(paths).toEqual(containers().map((container) => orchestratorPath(rootOf(container))));
    expect(paths).toEqual([
      "workspace/plugin/skills/run/SKILL.md",
      "sessions/android/plugin/skills/run/SKILL.md",
      "sessions/ios/plugin/skills/run/SKILL.md",
    ]);
  });

  it("walks only its own container's nodes: the ios orchestrator names no android node", () => {
    const ios = containers().find((container) => container.slug === "ios");
    expect(ios).toBeDefined();
    if (ios === undefined) return;

    const content = orchestratorSkill(ios, scope).content;

    expect(markers(content)).toEqual(["session-2-start", "session-2-plan", "session-2-stop"]);
    expect(content).not.toContain("session-1-");
    expect(content).not.toContain("fix-login-android");
    expect(content).toContain("fix-login-ios:plan");
  });
});
