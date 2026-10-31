import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { ports as agentPorts } from "../../../src/core/nodes/agent/ports.js";
import { settings as agentSettings } from "../../../src/core/nodes/agent/settings.js";
import { ports as askPorts } from "../../../src/core/nodes/ask/ports.js";
import { settings as askSettings } from "../../../src/core/nodes/ask/settings.js";
import { ports as forkPorts } from "../../../src/core/nodes/fork/ports.js";
import { settings as forkSettings } from "../../../src/core/nodes/fork/settings.js";
import { ports as gatePorts } from "../../../src/core/nodes/gate/ports.js";
import { settings as gateSettings } from "../../../src/core/nodes/gate/settings.js";
import { ports as hardstopPorts } from "../../../src/core/nodes/hardstop/ports.js";
import { settings as hardstopSettings } from "../../../src/core/nodes/hardstop/settings.js";
import { ports as joinPorts } from "../../../src/core/nodes/join/ports.js";
import { settings as joinSettings } from "../../../src/core/nodes/join/settings.js";
import { ports as loopPorts } from "../../../src/core/nodes/loop/ports.js";
import { settings as loopSettings } from "../../../src/core/nodes/loop/settings.js";
import { ports as outputPorts } from "../../../src/core/nodes/output/ports.js";
import { settings as outputSettings } from "../../../src/core/nodes/output/settings.js";
import { ports as promptPorts } from "../../../src/core/nodes/prompt/ports.js";
import { settings as promptSettings } from "../../../src/core/nodes/prompt/settings.js";
import { ports as scriptPorts } from "../../../src/core/nodes/script/ports.js";
import { settings as scriptSettings } from "../../../src/core/nodes/script/settings.js";
import { ports as triggerPorts } from "../../../src/core/nodes/trigger/ports.js";
import { settings as triggerSettings } from "../../../src/core/nodes/trigger/settings.js";

const inPort = { name: "in", direction: "in", kind: "then" };
const outPort = { name: "out", direction: "out", kind: "then" };

type Case = {
  type: string;
  settings: z.ZodType;
  ports: readonly unknown[];
  valid: Record<string, unknown>;
  bad: Record<string, unknown>;
  badPath: (string | number)[];
  expectedPorts: unknown[];
};

const cases: Case[] = [
  {
    type: "prompt",
    settings: promptSettings,
    ports: promptPorts,
    valid: { instructions: "Summarise" },
    bad: { instructions: 5 },
    badPath: ["instructions"],
    expectedPorts: [inPort, outPort],
  },
  {
    type: "script",
    settings: scriptSettings,
    ports: scriptPorts,
    valid: { command: "npm", args: ["test"] },
    bad: { command: "npm", args: "test" },
    badPath: ["args"],
    expectedPorts: [inPort, outPort],
  },
  {
    type: "agent",
    settings: agentSettings,
    ports: agentPorts,
    valid: {
      role: "reviewer",
      instructions: "Review",
      model: "sonnet",
      tools: ["Read"],
      given: ["plan.md"],
      writes: ["review.md"],
    },
    bad: { role: "reviewer", instructions: "Review", model: "sonnet", tools: "Read" },
    badPath: ["tools"],
    expectedPorts: [inPort, outPort],
  },
  {
    type: "gate",
    settings: gateSettings,
    ports: gatePorts,
    valid: { shown: "plan.md", skippable: false },
    bad: { shown: "plan.md", skippable: "no" },
    badPath: ["skippable"],
    expectedPorts: [inPort, outPort],
  },
  {
    type: "ask",
    settings: askSettings,
    ports: askPorts,
    valid: { question: "Ship?", options: ["yes", "no"] },
    bad: { question: "Ship?", options: "yes" },
    badPath: ["options"],
    expectedPorts: [inPort, outPort],
  },
  {
    type: "hardstop",
    settings: hardstopSettings,
    ports: hardstopPorts,
    valid: { condition: "tests fail", shown: "report", locked: true, enabled: true },
    bad: { condition: "tests fail", shown: "report", locked: true, enabled: "no" },
    badPath: ["enabled"],
    expectedPorts: [inPort, outPort],
  },
  {
    type: "loop",
    settings: loopSettings,
    ports: loopPorts,
    valid: { condition: "tests pass", cap: 3, onCap: "ask" },
    bad: { condition: "tests pass", cap: "three" },
    badPath: ["cap"],
    expectedPorts: [inPort, outPort],
  },
  {
    type: "trigger",
    settings: triggerSettings,
    ports: triggerPorts,
    valid: { inputs: ["ticket"], flags: { dryRun: false } },
    bad: { inputs: ["ticket"], flags: { dryRun: [] } },
    badPath: ["flags", "dryRun"],
    expectedPorts: [outPort],
  },
  {
    type: "output",
    settings: outputSettings,
    ports: outputPorts,
    valid: { name: "result", type: "text" },
    bad: { name: "result", type: 1 },
    badPath: ["type"],
    expectedPorts: [inPort],
  },
  {
    type: "fork",
    settings: forkSettings,
    ports: forkPorts,
    valid: {},
    bad: { branches: 2 },
    badPath: [],
    expectedPorts: [inPort, outPort],
  },
  {
    type: "join",
    settings: joinSettings,
    ports: joinPorts,
    valid: { wait: "first" },
    bad: { wait: "some" },
    badPath: ["wait"],
    expectedPorts: [inPort, outPort],
  },
];

describe.each(cases)("$type node", ({ settings, ports, valid, bad, badPath, expectedPorts }) => {
  it("accepts valid settings unchanged", () => {
    const result = settings.safeParse(valid);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(valid);
  });

  it("rejects a wrong-typed field, naming it", () => {
    const result = settings.safeParse(bad);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(badPath);
  });

  it("has exactly its ports", () => {
    expect(ports).toEqual(expectedPorts);
  });
});

describe("required and lenient settings", () => {
  it("rejects a script without a command", () => {
    const result = scriptSettings.safeParse({ args: ["test"] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["command"]);
  });

  it("accepts a loop without cap or onCap, capping it at 3", () => {
    expect(loopSettings.parse({ condition: "tests pass" })).toEqual({
      condition: "tests pass",
      cap: 3,
    });
  });

  it("accepts a join without wait, waiting for all", () => {
    expect(joinSettings.parse({})).toEqual({ wait: "all" });
  });

  it("rejects an unknown loop onCap", () => {
    const result = loopSettings.safeParse({ condition: "tests pass", onCap: "retry" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["onCap"]);
  });

  it("accepts an agent with empty instructions", () => {
    const result = agentSettings.safeParse({
      role: "reviewer",
      instructions: "",
      model: "sonnet",
      tools: [],
    });
    expect(result.success).toBe(true);
  });

  it("keeps a disabled hardstop's enabled flag", () => {
    const result = hardstopSettings.safeParse({
      condition: "tests fail",
      shown: "report",
      locked: true,
      enabled: false,
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ enabled: false });
  });
});
