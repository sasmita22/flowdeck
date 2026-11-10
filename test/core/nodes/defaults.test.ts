import { describe, expect, it } from "vitest";
import { validate } from "../../../src/core/compiler/validate.js";
import { NodeType, parseFlow } from "../../../src/core/flow/schema.js";
import * as agent from "../../../src/core/nodes/agent/defaults.js";
import * as ask from "../../../src/core/nodes/ask/defaults.js";
import * as branch from "../../../src/core/nodes/branch/defaults.js";
import * as foreach from "../../../src/core/nodes/foreach/defaults.js";
import * as fork from "../../../src/core/nodes/fork/defaults.js";
import * as gate from "../../../src/core/nodes/gate/defaults.js";
import * as hardstop from "../../../src/core/nodes/hardstop/defaults.js";
import * as join from "../../../src/core/nodes/join/defaults.js";
import * as loop from "../../../src/core/nodes/loop/defaults.js";
import * as output from "../../../src/core/nodes/output/defaults.js";
import { nodeDefaults } from "../../../src/core/nodes/defaults.js";
import * as trigger from "../../../src/core/nodes/trigger/defaults.js";
import {
  flow,
  output as stopNode,
  thenWire,
  trigger as startNode,
} from "../../fixtures/flow-builders.js";

type Defaults = { defaultSettings: object; defaultLabel: string };

const onTheMainFlow = (node: { id: string; type: string }) => {
  if (node.type === "trigger") return flow([node, stopNode("stop")], [thenWire(node.id, "stop")]);
  if (node.type === "output") return flow([startNode("start"), node], [thenWire("start", node.id)]);
  return flow(
    [startNode("start"), node, stopNode("stop")],
    [thenWire("start", node.id), thenWire("start", "stop")],
  );
};

const cases: [type: string, defaults: Defaults, label: string, rules: string[]][] = [
  ["agent", agent, "Agent", ["required-settings"]],
  ["gate", gate, "Gate", []],
  ["ask", ask, "Ask", ["required-settings"]],
  ["hardstop", hardstop, "Hard stop", []],
  ["loop", loop, "Loop", ["required-settings", "loop-body"]],
  ["trigger", trigger, "Start", []],
  ["output", output, "Stop", []],
  ["fork", fork, "Fork", ["parallel-section"]],
  ["join", join, "Join", ["parallel-section"]],
  ["foreach", foreach, "For each", ["loop-body"]],
  ["branch", branch, "Branch", ["branch-variable"]],
];

describe("defaults for every node type", () => {
  it.each(cases)(
    "%s parses on the main flow and reports only its known rules",
    (type, defaults, label, rules) => {
      const node = {
        id: `${type}-1`,
        type,
        label: defaults.defaultLabel,
        position: { x: 0, y: 0 },
        settings: defaults.defaultSettings,
      };
      const built = onTheMainFlow(node);

      expect(parseFlow(built)).toEqual(built);
      expect(defaults.defaultLabel).toBe(label);
      expect(validate(built).map((error) => error.rule)).toEqual(rules);
    },
  );
});

describe("node defaults", () => {
  it("has an entry for every node type and none for prompt or script", () => {
    expect(Object.keys(nodeDefaults).sort()).toEqual([...NodeType.options].sort());
    expect(Object.keys(nodeDefaults)).not.toContain("prompt");
    expect(Object.keys(nodeDefaults)).not.toContain("script");
  });
});
