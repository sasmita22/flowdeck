import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rules, validate } from "../../../src/core/compiler/validate.js";
import { parseFlow } from "../../../src/core/flow/schema.js";
import {
  agent,
  flow,
  forEach,
  loop,
  onMainFlow,
  output,
  thenWire,
  trigger,
  wire,
} from "../../fixtures/flow-builders.js";

const brokenDir = new URL("../../fixtures/broken/", import.meta.url);
const examplesDir = new URL("../../../examples/", import.meta.url);

const readJson = (dir: URL, name: string): unknown =>
  JSON.parse(readFileSync(new URL(name, dir), "utf8"));

const brokenFixtures = readdirSync(brokenDir).filter((name) => name.endsWith(".json"));

describe("validate", () => {
  it.each(brokenFixtures)("reports only its own rule for broken/%s", (name) => {
    const ruleIds = validate(parseFlow(readJson(brokenDir, name))).map((error) => error.rule);
    expect(new Set(ruleIds)).toEqual(new Set([name.replace(/\.json$/, "")]));
  });

  it("runs the variable and repository rules in place of branch-flag and session-folder", () => {
    const ids = rules.map((rule) => rule.id);

    expect(ids).toEqual(
      expect.arrayContaining([
        "undeclared-variable",
        "variable-names",
        "branch-variable",
        "repo-required",
      ]),
    );
    expect(ids).not.toContain("branch-flag");
    expect(ids).not.toContain("session-folder");
    expect(brokenFixtures).not.toContain("branch-flag.json");
    expect(brokenFixtures).not.toContain("session-folder.json");
  });

  it.each(["undeclared-variable", "variable-names", "branch-variable", "repo-required"])(
    "reports exactly %s for its broken fixture",
    (ruleId) => {
      const errors = validate(parseFlow(readJson(brokenDir, `${ruleId}.json`)));

      expect(errors.length).toBeGreaterThan(0);
      expect(new Set(errors.map((error) => error.rule))).toEqual(new Set([ruleId]));
    },
  );

  it("has one broken fixture per rule", () => {
    const fixtureIds = brokenFixtures.map((name) => name.replace(/\.json$/, ""));
    expect(new Set(fixtureIds)).toEqual(new Set(rules.map((rule) => rule.id)));
  });

  it("returns every broken rule at once, each on its node", () => {
    const input = flow(
      [
        trigger("start"),
        loop("retry", { settings: { cap: 0, onCap: "fail" } }),
        agent("build", { settings: { instructions: "   " } }),
        agent("stray"),
        forEach("each"),
        agent("each-a", { parent: "each" }),
        agent("each-p", { parent: "each" }),
        { ...forEach("inner"), parent: "retry" },
        agent("inner-p", { parent: "inner" }),
        output("stop"),
      ],
      [
        wire("start", "done", "stray", "in"),
        thenWire("stray", "retry"),
        thenWire("retry", "build"),
        thenWire("build", "each"),
        thenWire("each", "stop"),
      ],
    );
    expect(validate(input).map(({ rule, node }) => ({ rule, node }))).toEqual([
      { rule: "loop-cap", node: "retry" },
      { rule: "required-settings", node: "build" },
      { rule: "ports", node: "start" },
      { rule: "loop-body", node: "retry" },
      { rule: "loop-body", node: "inner" },
    ]);
  });

  it("refuses an Agent that asks for a tool the session does not allow", () => {
    const input = onMainFlow([agent("review", { settings: { tools: ["Bash"] } })], []);

    expect(validate(input).map(({ rule, node }) => ({ rule, node }))).toEqual([
      { rule: "agent-tools", node: "review" },
    ]);
  });

  it("rejects a hard stop edited off outside the app", () => {
    const parsed = parseFlow(readJson(brokenDir, "hardstop-locked.json"));
    expect(validate(parsed).map(({ rule, node, field }) => ({ rule, node, field }))).toEqual([
      { rule: "hardstop-locked", node: "stop", field: "enabled" },
    ]);
  });

  it.each(["all-types.json", "loop-review.json", "three-agents.json"])(
    "reports only the missing repository for examples/%s",
    (name) => {
      expect(validate(parseFlow(readJson(examplesDir, name))).map(({ rule }) => rule)).toEqual([
        "repo-required",
      ]);
    },
  );

  it("never reports a note, even one that reuses a node's id or has no text", () => {
    const valid = parseFlow(readJson(examplesDir, "three-agents.json"));
    const broken = parseFlow(readJson(brokenDir, "loop-cap.json"));
    const [firstNode] = valid.nodes;
    if (firstNode === undefined) throw new Error("three-agents.json has no nodes");
    const notes = [
      { id: firstNode.id, text: "", position: { x: 0, y: 0 }, size: { width: 1, height: 1 } },
      { id: "n 1!", text: "x", position: { x: -5, y: -5 }, size: { width: 200, height: 100 } },
    ];
    const noted = (flow: typeof valid) => parseFlow({ ...flow, notes });
    expect(noted(valid).notes).toHaveLength(2);

    expect(validate(noted(valid))).toEqual(validate(valid));
    expect(validate(noted(broken))).toEqual(validate(broken));
  });
});
