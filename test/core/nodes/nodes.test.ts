import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { ports as agentPorts } from "../../../src/core/nodes/agent/ports.js";
import { settings as agentSettings } from "../../../src/core/nodes/agent/settings.js";
import { ports as forkPorts } from "../../../src/core/nodes/fork/ports.js";
import { settings as forkSettings } from "../../../src/core/nodes/fork/settings.js";
import { ports as gatePorts } from "../../../src/core/nodes/gate/ports.js";
import { settings as gateSettings } from "../../../src/core/nodes/gate/settings.js";
import { ports as joinPorts } from "../../../src/core/nodes/join/ports.js";
import { settings as joinSettings } from "../../../src/core/nodes/join/settings.js";
import { ports as loopPorts } from "../../../src/core/nodes/loop/ports.js";
import { settings as loopSettings } from "../../../src/core/nodes/loop/settings.js";
import { ports as outputPorts } from "../../../src/core/nodes/output/ports.js";
import { settings as outputSettings } from "../../../src/core/nodes/output/settings.js";
import { registry } from "../../../src/core/nodes/registry.js";
import { ports as triggerPorts } from "../../../src/core/nodes/trigger/ports.js";
import { settings as triggerSettings } from "../../../src/core/nodes/trigger/settings.js";

const inPort = { name: "in", direction: "in", kind: "then" };
const outPort = { name: "out", direction: "out", kind: "then" };

type Case = {
  type: string;
  settings: z.ZodType;
  ports: readonly unknown[];
  valid: Record<string, unknown>;
  bad: unknown;
  badPath: (string | number)[];
  expectedPorts: unknown[];
};

const cases: Case[] = [
  {
    type: "agent",
    settings: agentSettings,
    ports: agentPorts,
    valid: {
      role: "reviewer",
      instructions: "Review",
      model: "sonnet",
      produces: [{ variable: "approved", yesIf: "it reads well", noIf: "it does not" }],
    },
    bad: { role: "reviewer", instructions: "Review", model: 1 },
    badPath: ["model"],
    expectedPorts: [inPort, outPort],
  },
  {
    type: "gate",
    settings: gateSettings,
    ports: gatePorts,
    valid: { stopWhen: "conditional", condition: "tests fail", instruction: "Report" },
    bad: { stopWhen: "sometimes", condition: "", instruction: "" },
    badPath: ["stopWhen"],
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
    valid: {},
    bad: "ticket",
    badPath: [],
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
    valid: { wait: "first", onBranchFail: "skip" },
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
  it("accepts a loop without cap or onCap, capping it at 3", () => {
    expect(loopSettings.parse({ condition: "tests pass" })).toEqual({
      condition: "tests pass",
      cap: 3,
    });
  });

  it("accepts a join without wait or a branch-fail choice, waiting for all and stopping", () => {
    expect(joinSettings.parse({})).toEqual({ wait: "all", onBranchFail: "stop" });
  });

  it("rejects an unknown join branch-fail choice", () => {
    const result = joinSettings.safeParse({ onBranchFail: "retry" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["onBranchFail"]);
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
    });
    expect(result.success).toBe(true);
  });

  it("has no tools setting on an agent, keeping its own model", () => {
    expect(Object.keys(agentSettings.shape)).not.toContain("tools");
    expect(
      agentSettings.parse({ role: "", instructions: "Go.", model: "haiku", tools: ["Read"] }),
    ).toEqual({ role: "", instructions: "Go.", model: "haiku" });
  });
});

describe("branch node", () => {
  it.each(["proceed-e2e", ""])("accepts the variable %j unchanged", (variable) => {
    expect(registry.branch.settings.safeParse({ variable }).data).toEqual({ variable });
  });

  it.each([{}, { variable: 1 }])("refuses the settings %j at the variable", (settings) => {
    const result = registry.branch.settings.safeParse(settings);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["variable"]);
  });

  it("has an in port and yes and no out ports", () => {
    expect(registry.branch.ports).toEqual([
      inPort,
      { name: "yes", direction: "out", kind: "then" },
      { name: "no", direction: "out", kind: "then" },
    ]);
  });
});
