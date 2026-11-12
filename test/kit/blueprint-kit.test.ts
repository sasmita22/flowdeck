import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { webGuardDecision } from "../../bin/flowdeck-web-guard.js";
import { GITHUB_READ_TOOLS } from "../../src/core/compiler/blueprint-session.js";
import { rules, validate } from "../../src/core/compiler/validate.js";
import { checkEdit } from "../../src/core/flow/blueprint-edits.js";
import { toolNames } from "../../src/core/flow/blueprint-tools.js";
import {
  BuildConfig,
  Variable,
  WireKind,
  type Port,
  type Wire,
} from "../../src/core/flow/schema.js";
import { agent, flow, output, thenWire, trigger, wire } from "../fixtures/flow-builders.js";
import { nodeDefaults } from "../../src/core/nodes/defaults.js";
import { registry } from "../../src/core/nodes/registry.js";
import { frontmatterOf } from "../fixtures/kit-frontmatter.js";

const kitDir = fileURLToPath(new URL("../../kit-blueprint/", import.meta.url));

const readKit = (path: string): string => {
  const full = join(kitDir, path);
  return existsSync(full) ? readFileSync(full, "utf8") : "";
};

const kitFiles = (dir = kitDir): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? kitFiles(full) : [relative(kitDir, full)];
  });
};

const skill = () => readKit("skills/blueprint/SKILL.md");

const variableKinds = Variable.options.map((option) => option.shape.kind.value);

const sectionOf = (content: string, heading: string): string => {
  const start = content.indexOf(`\n${heading}\n`);
  if (start === -1) return "";
  const rest = content.slice(start + heading.length + 2);
  const end = rest.search(/^## /m);
  return end === -1 ? rest : rest.slice(0, end);
};

const tableRows = (section: string): string[][] =>
  section
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(2)
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );

const backticked = (cell: string): string => /^`([^`]+)`$/.exec(cell)?.[1] ?? cell;

type NodeRow = {
  type: string;
  settings: string;
  defaults: Record<string, unknown>;
  ports: string[];
};

const portKey = ({ direction, name, kind }: Port) => `${direction} ${name} ${kind}`;

const defaultsIn = (cell: string): Record<string, unknown> => {
  const defaults: Record<string, unknown> = {};
  for (const [, key = "", value = ""] of cell.matchAll(/`(\w+)` \(([^;)]+)/g)) {
    try {
      defaults[key] = JSON.parse(value.trim());
    } catch {
      continue;
    }
  }
  return defaults;
};

const portsIn = (cell: string): string[] => {
  const ports: string[] = [];
  let pending: string[] = [];
  for (const [, direction, name, kind] of cell.matchAll(/(in|out) `([^`]+)`|\((\w+)\)/g)) {
    if (kind !== undefined) {
      ports.push(...pending.map((end) => `${end} ${kind}`));
      pending = [];
    } else {
      pending.push(`${direction ?? ""} ${name ?? ""}`);
    }
  }
  return ports.sort();
};

const nodeRows = (content: string): NodeRow[] =>
  tableRows(sectionOf(content, "## Nodes")).map(([type = "", , settings = "", ports = ""]) => ({
    type: backticked(type),
    settings,
    defaults: defaultsIn(settings),
    ports: portsIn(ports),
  }));

const toolsIn = (content: string): string[] =>
  tableRows(sectionOf(content, "## Tools")).map(([name = ""]) => backticked(name));

const ruleIdsIn = (content: string): string[] =>
  [...sectionOf(content, "## Validator rules").matchAll(/^- `([^`]+)`:/gm)].map(
    (match) => match[1] ?? "",
  );

const mismatch = (listed: readonly string[], defined: readonly string[]) => ({
  unlisted: defined.filter((name) => !listed.includes(name)),
  undefinedInCode: listed.filter((name) => !defined.includes(name)),
});

const matched = { unlisted: [], undefinedInCode: [] };

const nodeTypes = Object.keys(registry);

const registryPorts = (type: string): string[] =>
  [...(registry[type as keyof typeof registry]?.ports ?? [])].map(portKey).sort();

const ruleIds = rules.map((rule) => rule.id);

const settingKeys = (type: string): string[] => {
  const schema = registry[type as keyof typeof registry].settings;
  return schema instanceof z.ZodObject ? Object.keys(schema.shape) : [];
};

const namesFileWire = (text: string): boolean => /\bfile`?[- ]wires?\b/i.test(text);

const refusedWireRulesIn = (content: string): string[] => {
  const sentence = /[^.]*`wire` edit[^.]*refused[^.]*\./.exec(
    sectionOf(content, "## Validator rules"),
  )?.[0];
  return [...(sentence ?? "").matchAll(/`([^`]+)`/g)]
    .map((match) => match[1] ?? "")
    .filter((id) => ruleIds.includes(id))
    .sort();
};

type WireProbe = { refused: boolean; broken: string[] };

const wireProbes = (): WireProbe[] => {
  const base = flow(
    [trigger("start"), agent("a1"), agent("p1"), output("stop")],
    [thenWire("start", "a1"), thenWire("a1", "p1"), thenWire("p1", "stop")],
  );
  const known = new Set(validate(base).map((error) => error.rule));
  return [
    thenWire("a1", "ghost"),
    wire("a1", "nope", "p1", "in"),
    { ...thenWire("a1", "p1"), kind: "event" },
    thenWire("p1", "a1"),
  ].map((candidate) => ({
    refused: !checkEdit(base, "wire", candidate).ok,
    broken: validate({ ...base, wires: [...base.wires, candidate as Wire] })
      .map((error) => error.rule)
      .filter((id) => !known.has(id)),
  }));
};

const rulesBrokenBy = (probes: WireProbe[], refused: boolean): string[] =>
  [
    ...new Set(
      probes.filter((probe) => probe.refused === refused).flatMap((probe) => probe.broken),
    ),
  ].sort();

describe("the blueprint kit", () => {
  it("is the flowdeck-blueprint plugin", () => {
    const manifest = readKit(".claude-plugin/plugin.json");

    expect(manifest).not.toBe("");
    expect(JSON.parse(manifest)).toMatchObject({ name: "flowdeck-blueprint" });
  });

  it("has exactly the blueprint skills", () => {
    const skillDirs = existsSync(join(kitDir, "skills"))
      ? readdirSync(join(kitDir, "skills"), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      : [];

    expect(skillDirs).toEqual(["blueprint", "check-blueprint", "copy-flow", "write-node"]);
  });

  describe("authoring skills", () => {
    const writeNode = () => readKit("skills/write-node/SKILL.md");
    const copyFlow = () => readKit("skills/copy-flow/SKILL.md");

    it("write-node covers a node's role, instructions and expected output", () => {
      const content = writeNode();

      expect(content).toMatch(/\brole\b/i);
      expect(content).toMatch(/\binstructions\b/i);
      expect(content).toMatch(/expected output/i);
    });

    it("write-node makes every work step an Agent", () => {
      expect(sectionOf(writeNode(), "## Choose the type")).toMatch(
        /every work step is an `agent`/i,
      );
    });

    it("write-node says an Agent that is not the first step states what it builds on", () => {
      expect(sectionOf(writeNode(), "## Agent node")).toMatch(/Agent[^.\n]*builds on/);
    });

    it("write-node names the Agent's produces setting", () => {
      expect(sectionOf(writeNode(), "## Agent node")).toContain("`produces`");
    });

    it("copy-flow makes every work step an Agent", () => {
      expect(copyFlow()).toMatch(/every work step[^.\n]*an `agent`/i);
    });

    it("copy-flow reads the source with the Read tool", () => {
      expect(copyFlow()).toContain("`Read`");
    });

    it("copy-flow says no step is added or dropped", () => {
      expect(copyFlow()).toMatch(/no step[^.\n]*added or dropped/i);
    });

    it("copy-flow names github.com and raw.githubusercontent.com and no other host", () => {
      const hosts = [...copyFlow().matchAll(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi)]
        .map((match) => match[0].toLowerCase())
        .filter((name) => !/\.(md|json|ya?ml|ts|js|cjs|txt)$/.test(name));

      expect([...new Set(hosts)].sort()).toStrictEqual(["github.com", "raw.githubusercontent.com"]);
    });

    it("copy-flow no longer asks to save the page and names gh auth login", () => {
      const content = copyFlow();

      expect(content).not.toMatch(/save the page/i);
      expect(content).toContain("gh auth login");
    });

    it("copy-flow names only GitHub tools the pane is allowed", () => {
      const named = [...copyFlow().matchAll(/mcp__github__(\w+)/g)].map((match) => match[1]);

      expect(named).not.toHaveLength(0);
      for (const tool of named) expect(GITHUB_READ_TOOLS).toContain(tool);
    });

    it("copy-flow refuses other addresses in the web guard's words", () => {
      const reason = webGuardDecision(undefined)?.hookSpecificOutput.permissionDecisionReason ?? "";
      const clause = reason.replace(/\.$/, "").replace(/^./, (first) => first.toLowerCase());

      expect(clause).not.toBe("");
      expect(copyFlow()).toContain(`say that ${clause}.`);
    });

    it("blueprint's copy-flow pointer mentions a GitHub link", () => {
      const pointer = skill()
        .split("\n")
        .find((line) => line.includes("`copy-flow`"));

      expect(pointer).toMatch(/GitHub link/i);
    });

    it.each(["write-node", "check-blueprint"])("%s never tells the pane to fetch", (name) => {
      const content = readKit(`skills/${name}/SKILL.md`);

      expect(content).not.toBe("");
      expect(content).not.toMatch(/WebFetch|WebSearch|\bfetch\b/i);
    });
  });

  it("has a SKILL.md with its name and a description", () => {
    const fields = frontmatterOf(skill());

    expect(fields.get("name")).toBe("blueprint");
    expect(fields.get("description") ?? "").not.toBe("");
  });

  it("names all ten tools", () => {
    const content = skill();

    expect(toolNames).toHaveLength(10);
    for (const name of toolNames) expect(content, name).toContain(`\`${name}\``);
  });

  it("names the two wire kinds", () => {
    const content = skill();

    expect(WireKind.options).toEqual(["then", "event"]);
    for (const kind of WireKind.options) expect(content, kind).toContain(`\`${kind}\``);
  });

  it("states the one-session rule", () => {
    expect(skill()).toMatch(/one session/i);
  });

  it("names the build configuration fields and the variable kinds", () => {
    const content = skill();

    for (const field of Object.keys(BuildConfig.shape)) {
      expect(content, field).toContain(`\`${field}\``);
    }
    for (const kind of variableKinds) expect(content, kind).toContain(`\`${kind}\``);
  });

  it("names every validator rule", () => {
    const content = skill();

    for (const rule of rules) expect(content, rule.id).toContain(`\`${rule.id}\``);
  });

  it.each(["one-start", "stop-required"])("names the %s rule", (id) => {
    expect(skill()).toContain(`\`${id}\``);
  });

  it("says to call read_blueprint before any edit", () => {
    expect(skill()).toMatch(/`read_blueprint`[^.\n]*before[^.\n]*edit/i);
  });

  it("says to ask a question instead of editing when an ask is unclear", () => {
    expect(skill()).toMatch(/unclear[^.\n]*question[^.\n]*instead of edit/i);
  });

  describe("matches the code both ways", () => {
    const rows = nodeRows(skill());

    it("lists exactly the registry's node types", () => {
      expect(rows.length).toBeGreaterThan(0);
      expect(
        mismatch(
          rows.map((row) => row.type),
          nodeTypes,
        ),
      ).toEqual(matched);
    });

    it.each(nodeTypes)("gives the %s node the registry's ports", (type) => {
      const row = rows.find((candidate) => candidate.type === type);

      expect(row?.ports).toEqual(registryPorts(type));
    });

    it.each(nodeTypes)("names every setting the %s node's schema has", (type) => {
      const row = rows.find((candidate) => candidate.type === type);

      expect(settingKeys(type).filter((key) => !row?.settings.includes(`\`${key}\``))).toEqual([]);
    });

    it("reads a setting left out of a node row as a mismatch", () => {
      const row = rows.find((candidate) => candidate.type === "agent");
      const without = row?.settings.replace("`role`", "role") ?? "";

      expect(settingKeys("agent").filter((key) => !without.includes(`\`${key}\``))).toContain(
        "role",
      );
    });

    it.each(nodeTypes)("gives the %s node its default settings", (type) => {
      const row = rows.find((candidate) => candidate.type === type);

      expect(row?.defaults).toEqual(nodeDefaults[type as keyof typeof nodeDefaults].settings);
    });

    it("lists exactly the blueprint tools", () => {
      expect(mismatch(toolsIn(skill()), toolNames)).toEqual(matched);
    });

    it("lists exactly the validator rule ids", () => {
      expect(mismatch(ruleIdsIn(skill()), ruleIds)).toEqual(matched);
    });

    it("reads a node table with a row missing or added as a mismatch", () => {
      const types = rows.map((row) => row.type);

      expect(mismatch(types.slice(1), nodeTypes).unlisted).toEqual([types[0]]);
      expect(mismatch([...types, "teleport"], nodeTypes).undefinedInCode).toEqual(["teleport"]);
    });

    it("reads a tool or rule id the code does not have as a mismatch", () => {
      expect(mismatch([...toolsIn(skill()), "run_build"], toolNames).undefinedInCode).toEqual([
        "run_build",
      ]);
      expect(mismatch([...ruleIdsIn(skill()), "no-gates"], ruleIds).undefinedInCode).toEqual([
        "no-gates",
      ]);
    });

    it("names the rules a wire edit is refused for, as checkEdit refuses it", () => {
      const probes = wireProbes();

      expect(probes.some((probe) => probe.refused)).toBe(true);
      expect(probes.some((probe) => !probe.refused && probe.broken.length > 0)).toBe(true);
      expect(refusedWireRulesIn(skill())).toEqual(rulesBrokenBy(probes, true));
      expect(
        rulesBrokenBy(probes, false).filter((id) => refusedWireRulesIn(skill()).includes(id)),
      ).toEqual([]);
    });

    it("reads a refused-wire sentence that names a reported rule as a mismatch", () => {
      const intro =
        "## Validator rules\n\nA `wire` edit that breaks `ports` or `no-cycle` is refused.\n";

      expect(refusedWireRulesIn(intro)).not.toEqual(rulesBrokenBy(wireProbes(), true));
    });

    it("reads a changed port or default as a mismatch", () => {
      const forkRow =
        '| `fork` | Parallel start | `wait` ("all") | in `in`; out `a`, out `b` (then) |';
      const [row] = nodeRows(`## Nodes\n\n| h |\n| - |\n${forkRow}\n`);

      expect(row?.ports).not.toEqual(registryPorts("fork"));
      expect(row?.defaults).not.toEqual(nodeDefaults.fork.settings);
    });
  });

  it("names no Prompt or Script node in any file", () => {
    const files = kitFiles();

    expect(files.length).toBeGreaterThan(0);
    expect(
      files.filter((file) => /\b(Prompt|Script)s?\b|`(prompt|script)`/.test(readKit(file))),
    ).toEqual([]);
  });

  it("names no File wire in any file", () => {
    const files = kitFiles();

    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((file) => namesFileWire(readKit(file)))).toEqual([]);
  });

  it("reads a File wire, a `file` wire or the file-wires rule as naming a File wire", () => {
    expect(namesFileWire("a File wire carries it")).toBe(true);
    expect(namesFileWire("`file-wires`: a rule")).toBe(true);
    expect(namesFileWire("a `file` wire for each file")).toBe(true);
    expect(namesFileWire("a file the writer leaves")).toBe(false);
  });

  it("leaves no file marked @unfilled", () => {
    const files = kitFiles();

    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((file) => readKit(file).includes("@unfilled"))).toEqual([]);
  });
});
