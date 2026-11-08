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

  it.each([
    "agents/piece-auditor.md",
    "agents/handoff-auditor.md",
    "skills/audit-handoffs/SKILL.md",
    "skills/fit-to-repo/SKILL.md",
    "skills/write-script/SKILL.md",
    "skills/write-agent/SKILL.md",
    "skills/audit-orchestrator/SKILL.md",
    "skills/audit-duplicates/SKILL.md",
  ])("%s says a question is only for a blueprint input", (path) => {
    const content = readKit(path);

    expect(content).toContain("A question is only for a blueprint input");
    expect(content).toContain("decided inside the node's portion, never a question");
    expect(content).not.toContain("leaves undecided");
  });

  it.each(["agents/piece-auditor.md", "agents/handoff-auditor.md"])(
    "%s has no never-guess banner",
    (path) => {
      expect(readKit(path)).not.toContain("Never guess");
    },
  );

  it("agent piece-auditor fixes a piece within its portion instead of asking", () => {
    const content = readKit("agents/piece-auditor.md");

    expect(content).toContain("stays as drafted or is fixed within its portion");
    expect(content).not.toContain("becomes a question");
    expect(content).not.toContain("Add a question naming the node");
    expect(content).not.toContain("If you cannot, add a question");
  });

  it("agent piece-auditor names the reader of a file no node writes as the question's node", () => {
    expect(readKit("agents/piece-auditor.md")).toContain(
      'For a read with no writer, `"nodeId"` is the reader and `"otherNodeId"` the upstream node expected to write it.',
    );
  });

  it("agent handoff-auditor never asks about what only code or the user can change", () => {
    expect(readKit("agents/handoff-auditor.md")).not.toContain("only code or the user can change");
  });

  it("skill write-agent writes with the allowed tools and invents no stop rule", () => {
    const content = skill("write-agent");

    expect(content).toContain("write the piece with the allowed tools");
    expect(content).not.toContain("the allow list lacks is a question");
    expect(content).toContain(
      "a stuck path or a retry cap only where the node's own text states one",
    );
    expect(content).not.toContain("stop and report the blocker");
  });

  it("skill write-script keeps the node's command as written instead of asking", () => {
    const content = skill("write-script");

    expect(content).toContain("stays as the node wrote it");
    expect(content).not.toContain("fixed mechanically");
    expect(content).not.toContain("becomes a question");
    expect(content).not.toContain("add a question");
    expect(content).not.toContain("one question naming the node");
  });

  it("skill fit-to-repo quotes the repo's gate and adds no obligation", () => {
    const content = skill("fit-to-repo");

    expect(content).toContain("quote that gate's command exactly as the repo writes it");
    expect(content).toContain(
      "A node that reviews or checks work judges it against the repo's gates",
    );
    expect(content).toContain(
      "- [ ] A review or check piece names each repo gate with its command quoted.",
    );
    expect(content).toContain(
      "never add a step, gate or obligation the node's own steps do not call for",
    );
    expect(content).not.toContain("If the piece cannot work without that answer");
  });

  it("skill audit-orchestrator adds no rule the nodes do not state", () => {
    const content = skill("audit-orchestrator");

    expect(content).toContain(
      "A rule the blueprint's nodes do not state is never added and never a question",
    );
    expect(content).toContain("A flow with none of these nodes gets no such rule");
    expect(content).not.toContain("is a question naming its node");
  });

  it("skill audit-handoffs limits retries to the node's text and names the user's gap", () => {
    const content = skill("audit-handoffs");

    expect(content).toContain("only to a retry the node's own text states");
    expect(content).toContain("gap the user must close");
    expect(content).not.toContain("code or the user must close");
    expect(content).not.toContain("Every loop and retry has a cap");
    expect(content).not.toContain('a missing "at most 3 tries"');
  });

  it("skill audit-duplicates keeps unmergeable nodes apart without asking", () => {
    const content = skill("audit-duplicates");

    expect(content).toContain("keep them apart, never a question");
    expect(content).not.toContain("add a question naming both nodes");
  });

  it("leaves no file marked @unfilled", () => {
    const files = kitFiles();

    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((file) => readKit(file).includes("@unfilled"))).toEqual([]);
  });
});
