import { describe, expect, it } from "vitest";
import { validate } from "../../../src/core/compiler/validate.js";
import { parseFlow } from "../../../src/core/flow/schema.js";
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
import * as trigger from "../../../src/core/nodes/trigger/defaults.js";
import { flow } from "../../fixtures/flow-builders.js";

type Defaults = { defaultSettings: object; defaultLabel: string };

const cases: [type: string, defaults: Defaults, label: string, rules: string[]][] = [
  ["agent", agent, "Agent", []],
  ["gate", gate, "Gate", []],
  ["ask", ask, "Ask", []],
  ["hardstop", hardstop, "Hard stop", []],
  ["loop", loop, "Loop", []],
  ["trigger", trigger, "Trigger", []],
  ["output", output, "Output", []],
  ["fork", fork, "Fork", ["parallel-section"]],
  ["join", join, "Join", ["parallel-section"]],
  ["foreach", foreach, "For each", ["foreach-first-prompt"]],
  ["branch", branch, "Branch", ["branch-flag"]],
];

describe("defaults for every node type", () => {
  it.each(cases)(
    "%s parses alone and reports only its known rules",
    (type, defaults, label, rules) => {
      const node = {
        id: `${type}-1`,
        type,
        label: defaults.defaultLabel,
        position: { x: 0, y: 0 },
        settings: defaults.defaultSettings,
      };
      const built = flow([node], []);

      expect(parseFlow(built)).toEqual(built);
      expect(defaults.defaultLabel).toBe(label);
      expect(validate(built).map((error) => error.rule)).toEqual(rules);
    },
  );
});
