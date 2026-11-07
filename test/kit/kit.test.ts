import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildReportSchema } from "../../src/core/compiler/build-report.js";
import { scopeLine } from "../../src/core/compiler/scope-line.js";

const kitDir = fileURLToPath(new URL("../../kit/", import.meta.url));

const skillNames = [
  "write-skill",
  "write-agent",
  "write-step",
  "write-handoff-template",
  "write-script",
  "fit-to-repo",
  "audit-handoffs",
  "audit-duplicates",
  "audit-orchestrator",
  "write-workspace-rules",
];

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

const skill = (name: string) => readKit(`skills/${name}/SKILL.md`);

const scopeLineFragments = scopeLine({ build: "\0", repo: "\0", workspace: "\0" })
  .split("\0")
  .filter((fragment) => fragment.trim() !== "");

const reportFields = Object.keys(buildReportSchema.shape);

describe("the build kit", () => {
  it("is the flowdeck-build plugin", () => {
    const manifest = readKit(".claude-plugin/plugin.json");

    expect(manifest).not.toBe("");
    expect(JSON.parse(manifest)).toMatchObject({ name: "flowdeck-build" });
  });

  it("has exactly the ten build skills", () => {
    const skillDirs = existsSync(join(kitDir, "skills"))
      ? readdirSync(join(kitDir, "skills"), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      : [];

    expect([...skillDirs].sort()).toEqual([...skillNames].sort());
  });

  it.each(skillNames)("skill %s has a SKILL.md with its name and a description", (name) => {
    const fields = frontmatterOf(skill(name));

    expect(fields.get("name")).toBe(name);
    expect(fields.get("description") ?? "").not.toBe("");
  });

  it.each(["write-skill", "write-agent"])(
    "%s requires the scope line first in every description and has it checked",
    (name) => {
      const content = skill(name);

      for (const fragment of scopeLineFragments) expect(content).toContain(fragment);
      expect(content).toMatch(/check[^.\n]*scope line|scope line[^.\n]*check/i);
    },
  );

  it.each([
    ["audit-handoffs", ["questions"]],
    ["audit-duplicates", ["merges", "keptApart"]],
  ])("%s names the build-report.json fields it writes", (name, fields) => {
    const content = skill(name);

    expect(content).toContain("build-report.json");
    for (const field of fields) {
      expect(reportFields).toContain(field);
      expect(content).toContain(`\`${field}\``);
    }
  });

  it.each(["piece-auditor", "handoff-auditor"])("agent %s may only read and edit", (name) => {
    const fields = frontmatterOf(readKit(`agents/${name}.md`));

    expect(fields.get("name")).toBe(name);
    expect(fields.get("tools")).toBe("Read, Edit, Glob, Grep");
  });

  it.each([
    ["skill fit-to-repo", "skills/fit-to-repo/SKILL.md"],
    ["agent piece-auditor", "agents/piece-auditor.md"],
    ["agent handoff-auditor", "agents/handoff-auditor.md"],
  ])("%s finds the target repo at the prompt's REPO path", (_, path) => {
    expect(readKit(path)).toContain("`REPO <path>`");
  });

  it.each([
    ["skill fit-to-repo", "skills/fit-to-repo/SKILL.md"],
    ["agent piece-auditor", "agents/piece-auditor.md"],
    ["agent handoff-auditor", "agents/handoff-auditor.md"],
  ])("%s says run-time facts are never build-time questions", (_, path) => {
    const content = readKit(path);

    expect(content).toContain("never build-time questions");
    for (const fact of ["branch", "diff", "git state", "script output", "files will exist"]) {
      expect(content, fact).toContain(fact);
    }
  });

  it.each(["write-handoff-template", "audit-handoffs", "write-agent", "write-step"])(
    "skill %s lets a node's own instructions narrow its file's form over the template",
    (name) => {
      expect(skill(name)).toContain("the node's own instructions win");
    },
  );

  it("audit-handoffs never asks about a node narrowing its template", () => {
    expect(skill("audit-handoffs")).toMatch(/starting point, not a contract[^\n]*never a question/);
  });

  it("audit-duplicates merges same-job nodes whatever their output layout or wording, never asking", () => {
    expect(skill("audit-duplicates")).toMatch(
      /layout or wording[^\n]*never block a merge[^\n]*never a question/,
    );
  });

  it.each([
    ["skill write-agent", "skills/write-agent/SKILL.md"],
    ["skill write-step", "skills/write-step/SKILL.md"],
    ["agent piece-auditor", "agents/piece-auditor.md"],
  ])("%s keeps each merged node's own layout as that node's details", (_, path) => {
    expect(readKit(path)).toContain("`NODE <id>: <layout>`");
  });

  it("leaves no file marked @unfilled", () => {
    const files = kitFiles();

    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((file) => readKit(file).includes("@unfilled"))).toEqual([]);
  });
});
