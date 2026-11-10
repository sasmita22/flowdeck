import { describe, expect, it } from "vitest";
import { lower } from "../../../src/core/compiler/lower.js";
import { orchestratorSkill } from "../../../src/core/compiler/orchestrator.js";
import { pieceNames } from "../../../src/core/compiler/pieces.js";
import { scopeLine } from "../../../src/core/compiler/scope-line.js";
import { order } from "../../../src/core/flow/order.js";
import type { Flow } from "../../../src/core/flow/schema.js";
import {
  agent,
  ask,
  branch,
  flow,
  forEach,
  fork,
  gate,
  hardstop,
  join,
  loop,
  output,
  thenWire,
  trigger,
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
      forEach("fe", { file: "units.md" }),
      labelled(agent("fp", { parent: "fe" }), "Unit"),
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
      thenWire("l", "fe"),
      thenWire("fe", "fp"),
      thenWire("fe", "b"),
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
  const pieces = pieceNames(input);
  return {
    ...manifest,
    nodes: manifest.nodes.map((node) => {
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
  it("writes plugin/skills/run/SKILL.md named run, its description opening with the scope line", () => {
    const { path, content } = skill();
    const fields = frontmatter(content);

    expect(path).toBe("plugin/skills/run/SKILL.md");
    expect(fields.name).toBe("run");
    expect(String(fields.description).startsWith(scopeLine(scope))).toBe(true);
  });

  it("lists every manifest node once, in the order the runner uses, each with its node marker", () => {
    const ids = stepLines(skill().content).map((line) => /NODE (\S+) /.exec(line)?.[1]);

    expect(ids).toEqual(order(sample()));
    expect(ids).toEqual(manifestOf(sample()).nodes.map((node) => node.id));
  });

  it("says hand-off files are named bare in the run's working folder, which sits at the repo folder in the workspace, never the workspace itself", () => {
    const { content } = skill();

    expectBareHandoffRule(content, "carousell-web");
    expect(
      nestedHandoffPaths(content, "carousell-web", ["plan.md", "code.md", "units.md"]),
    ).toEqual([]);
  });

  it("hands work only to agents: no step reads a skill or runs a command, and no line names a Prompt", () => {
    const { content } = skill();

    expect(lineOf(content, "p")).toContain("dispatch `fix-login:plan`");
    expect(content).not.toMatch(/by path and follow it|check its exit code|Prompt/);
  });

  it("dispatches an Agent node by its full name with its node marker and details, and waits", () => {
    const line = lineOf(skill().content, "a");

    expect(line).toContain("dispatch `fix-login:code`");
    expect(line).toContain(JSON.stringify("NODE a\nYou are given: plan.md\nWrite: code.md\nGo"));
    expect(line).toContain("wait");
  });

  it("lists a file once in a dispatch when the node declares the file its File wire carries", () => {
    const declared = flow(
      [
        labelled(agent("a", { settings: { given: ["plan.md"], writes: ["code.md"] } }), "Code"),
        labelled(agent("p"), "Ship"),
      ],
      [
        thenWire("a", "p"),
        {
          kind: "file",
          from: { node: "a", port: "file-out" },
          to: { node: "p", port: "file-in" },
          file: "code.md",
        },
      ],
    );

    expect(lineOf(skill(declared).content, "a")).toContain(
      JSON.stringify("NODE a\nYou are given: plan.md\nWrite: code.md\nGo"),
    );
  });

  it("asks in the chat for a Gate and an Ask", () => {
    expect(lineOf(skill().content, "g")).toMatch(/ask in the chat.*Check the plan/i);
    expect(lineOf(skill().content, "k")).toMatch(/ask in the chat.*Pick a colour.*red, blue/i);
  });

  it("repeats a Loop up to its cap and a For each once per item", () => {
    const content = skill().content;

    expect(lineOf(content, "l")).toMatch(/repeat.*NODE la.*tests pass.*at most 4 rounds/);
    expect(lineOf(content, "fe")).toMatch(/units\.md.*NODE fp/);
  });

  it("reads a Branch's variable from the build summary and names both ways", () => {
    expect(lineOf(skill().content, "b")).toMatch(
      /proceed.*build summary.*yes.*NODE f.*no.*NODE h/i,
    );
  });

  it("dispatches every Fork branch agent by full name in one message", () => {
    const line = lineOf(skill().content, "f");

    expect(line).toMatch(/one message/);
    expect(line).toContain("`fix-login:check`");
    expect(line).toContain("`fix-login:check-2`");
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
    for (const [, prefix] of named) expect(prefix).toBe("fix-login");
  });
});
