import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rules } from "../../src/core/compiler/validate.js";
import { toolNames } from "../../src/core/flow/blueprint-tools.js";
import { BuildConfig, Variable, WireKind } from "../../src/core/flow/schema.js";

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

const frontmatterOf = (content: string): Map<string, string> => {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(content)?.[1] ?? "";
  const fields = new Map<string, string>();
  for (const line of block.split("\n")) {
    const match = /^([\w-]+):\s*(.*)$/.exec(line);
    if (match !== null) fields.set(match[1] ?? "", (match[2] ?? "").trim());
  }
  return fields;
};

const skill = () => readKit("skills/blueprint/SKILL.md");

const variableKinds = Variable.options.map((option) => option.shape.kind.value);

describe("the blueprint kit", () => {
  it("is the flowdeck-blueprint plugin", () => {
    const manifest = readKit(".claude-plugin/plugin.json");

    expect(manifest).not.toBe("");
    expect(JSON.parse(manifest)).toMatchObject({ name: "flowdeck-blueprint" });
  });

  it("has exactly the blueprint skill", () => {
    const skillDirs = existsSync(join(kitDir, "skills"))
      ? readdirSync(join(kitDir, "skills"), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      : [];

    expect(skillDirs).toEqual(["blueprint"]);
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

  it("names the three wire kinds", () => {
    const content = skill();

    expect(WireKind.options).toEqual(["then", "file", "event"]);
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

  it("leaves no file marked @unfilled", () => {
    const files = kitFiles();

    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((file) => readKit(file).includes("@unfilled"))).toEqual([]);
  });
});
