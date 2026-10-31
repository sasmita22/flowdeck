import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rules, validate } from "../../../src/core/compiler/validate.js";
import { parseFlow } from "../../../src/core/flow/schema.js";
import {
  agent,
  flow,
  forEach,
  loop,
  prompt,
  thenWire,
  trigger,
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
        prompt("stray"),
        forEach("each"),
        agent("each-a", { parent: "each" }),
        prompt("each-p", { parent: "each" }),
        { ...forEach("inner"), parent: "retry" },
        prompt("inner-p", { parent: "inner" }),
      ],
      [thenWire("stray", "start")],
    );
    expect(validate(input).map(({ rule, node }) => ({ rule, node }))).toEqual([
      { rule: "loop-cap", node: "retry" },
      { rule: "required-settings", node: "build" },
      { rule: "ports", node: "start" },
      { rule: "foreach-first-prompt", node: "each" },
      { rule: "foreach-nesting", node: "inner" },
    ]);
  });

  it("rejects a hard stop edited off outside the app", () => {
    const parsed = parseFlow(readJson(brokenDir, "hardstop-locked.json"));
    expect(validate(parsed).map(({ rule, node, field }) => ({ rule, node, field }))).toEqual([
      { rule: "hardstop-locked", node: "stop", field: "enabled" },
    ]);
  });

  it.each(["all-types.json", "loop-review.json", "three-prompts.json"])(
    "accepts examples/%s",
    (name) => {
      expect(validate(parseFlow(readJson(examplesDir, name)))).toEqual([]);
    },
  );
});
