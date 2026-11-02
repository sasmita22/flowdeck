import { describe, expect, it } from "vitest";
import { BAR_MIN_HEIGHT, nodeLook, tagWidth } from "../../../../src/app/renderer/nodes/look.js";
import type { NodeType } from "../../../../src/core/flow/schema.js";
import { registry } from "../../../../src/core/nodes/registry.js";

const types = Object.keys(registry) as NodeType[];

const groups: Record<NodeType, string> = {
  trigger: "var(--c-io)",
  output: "var(--c-io)",
  prompt: "var(--c-work)",
  agent: "var(--c-work)",
  script: "var(--c-work)",
  gate: "var(--c-human)",
  hardstop: "var(--c-human)",
  ask: "var(--c-human)",
  loop: "var(--c-ctrl)",
  fork: "var(--c-ctrl)",
  join: "var(--c-ctrl)",
  foreach: "var(--c-ctrl)",
  branch: "var(--c-ctrl)",
};

const tags: Record<NodeType, string> = {
  trigger: "TRG",
  output: "OUT",
  prompt: "STP",
  agent: "AGT",
  script: "SH",
  gate: "GATE",
  hardstop: "STOP",
  ask: "ASK",
  loop: "LOOP",
  fork: "PARALLEL START",
  join: "PARALLEL END",
  foreach: "EACH",
  branch: "IF",
};

const outlines: Record<NodeType, string> = {
  trigger: "var(--c-io)",
  output: "var(--c-io)",
  agent: "var(--c-work)",
  ask: "var(--c-human)",
  hardstop: "var(--c-human)",
  prompt: "var(--line)",
  gate: "var(--line)",
  script: "var(--term-bg)",
  loop: "none",
  fork: "var(--c-ctrl)",
  join: "var(--c-ctrl)",
  foreach: "none",
  branch: "var(--c-ctrl)",
};

describe("nodeLook", () => {
  it("has a look for every registry type", () => {
    for (const type of types) expect(nodeLook(type)).toBeDefined();
  });

  it("has no look for a type outside the registry", () => {
    expect(nodeLook("nope" as NodeType)).toBeUndefined();
  });

  it.each(types)("colours %s with its group token", (type) => {
    expect(nodeLook(type).group).toBe(groups[type]);
  });

  it.each(types)("tags %s with its design code", (type) => {
    expect(nodeLook(type).tag).toBe(tags[type]);
  });

  it.each(types)("outlines %s with its own stroke", (type) => {
    expect(nodeLook(type).outline).toBe(outlines[type]);
  });

  it.each(types.filter((type) => !["ask", "fork", "join", "branch"].includes(type)))(
    "boxes %s at 170x48",
    (type) => {
      expect(nodeLook(type).box).toEqual({ width: 170, height: 48 });
    },
  );

  it.each(["fork", "join"] as const)(
    "boxes a lone %s as a 28-wide bar of the minimum height",
    (type) => {
      expect(nodeLook(type).box).toEqual({ width: 28, height: BAR_MIN_HEIGHT });
    },
  );

  it("keeps a bar tall enough for the longest parallel tag", () => {
    expect(BAR_MIN_HEIGHT).toBeGreaterThan(tagWidth("PARALLEL START"));
    expect(BAR_MIN_HEIGHT).toBeLessThanOrEqual(tagWidth("PARALLEL START") + 8);
  });

  it("draws foreach as a control frame tagged EACH with no outline, boxed at 170x48", () => {
    expect(nodeLook("foreach")).toMatchObject({
      group: "var(--c-ctrl)",
      tag: "EACH",
      outline: "none",
      box: { width: 170, height: 48 },
    });
  });

  it("boxes branch at 116x48 for its hexagon", () => {
    expect(nodeLook("branch").box).toEqual({ width: 116, height: 48 });
  });

  it("gives branch an in port and yes and no out ports", () => {
    const names = (direction: "in" | "out") =>
      nodeLook("branch")
        .ports.filter((port) => port.direction === direction)
        .map((port) => port.name);

    expect(names("in")).toEqual(["in"]);
    expect(names("out")).toEqual(["yes", "no"]);
  });

  it("boxes ask at 170x57 so its tail fits", () => {
    expect(nodeLook("ask").box).toEqual({ width: 170, height: 57 });
  });

  it.each(types)("gives %s the registry's ports", (type) => {
    expect(nodeLook(type).ports).toEqual(registry[type].ports);
  });

  it("gives trigger only an out port and output only an in port", () => {
    expect(nodeLook("trigger").ports.map((port) => port.name)).toEqual(["out"]);
    expect(nodeLook("output").ports.map((port) => port.name)).toEqual(["in"]);
  });
});
