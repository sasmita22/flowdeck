import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { NodeType, Port } from "../../../src/core/flow/schema.js";
import { settings as agent } from "../../../src/core/nodes/agent/settings.js";
import { settings as ask } from "../../../src/core/nodes/ask/settings.js";
import { settings as branch } from "../../../src/core/nodes/branch/settings.js";
import { settings as foreach } from "../../../src/core/nodes/foreach/settings.js";
import { settings as fork } from "../../../src/core/nodes/fork/settings.js";
import { settings as gate } from "../../../src/core/nodes/gate/settings.js";
import { settings as hardstop } from "../../../src/core/nodes/hardstop/settings.js";
import { settings as join } from "../../../src/core/nodes/join/settings.js";
import { settings as loop } from "../../../src/core/nodes/loop/settings.js";
import { settings as output } from "../../../src/core/nodes/output/settings.js";
import { registry } from "../../../src/core/nodes/registry.js";
import { settings as trigger } from "../../../src/core/nodes/trigger/settings.js";

const nodesDir = fileURLToPath(new URL("../../../src/core/nodes/", import.meta.url));
const folderSettings = {
  agent,
  gate,
  ask,
  hardstop,
  loop,
  trigger,
  output,
  fork,
  join,
  foreach,
  branch,
};
const entries: Partial<Record<string, { settings: unknown; ports: unknown }>> = registry;

describe("node registry", () => {
  it("matches the type enum and the node folders", () => {
    const folders = readdirSync(nodesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const types = [...NodeType.options].sort();
    expect(Object.keys(registry).sort()).toEqual(types);
    expect(folders.sort()).toEqual(types);
  });

  it.each(["prompt", "script"])("has no %s entry", (type) => {
    expect(Object.keys(registry)).not.toContain(type);
  });

  it.each(NodeType.options)("lists %s with its folder's settings and valid ports", (type) => {
    const entry = entries[type];
    expect(z.array(Port).safeParse(entry?.ports).success).toBe(true);
    expect(entry?.settings).toBe(folderSettings[type]);
  });

  it.each(NodeType.options)("gives %s Then ports only, none named file-in or file-out", (type) => {
    const ports = entries[type]?.ports as Port[];
    expect(ports.filter((port) => port.kind !== "then")).toEqual([]);
    expect(ports.map((port) => port.name)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^file-(in|out)$/)]),
    );
  });

  it.each(NodeType.options)("names every %s port once", (type) => {
    const ports = entries[type]?.ports as Port[];
    expect(new Set(ports.map((port) => port.name)).size).toBe(ports.length);
  });
});
