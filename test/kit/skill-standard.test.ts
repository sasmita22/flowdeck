import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bodyOf } from "../fixtures/frontmatter.js";
import { frontmatterOf } from "../fixtures/kit-frontmatter.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

type Covered = { path: string; name: string; content: string };

const folders = (dir: string): string[] =>
  existsSync(join(root, dir))
    ? readdirSync(join(root, dir), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];

const markdown = (dir: string): string[] =>
  existsSync(join(root, dir))
    ? readdirSync(join(root, dir)).filter((name) => name.endsWith(".md"))
    : [];

const covered = (path: string, name: string): Covered => ({
  path,
  name,
  content: readFileSync(join(root, path), "utf8"),
});

const skillsIn = (dir: string): Covered[] =>
  folders(dir).map((name) => covered(`${dir}/${name}/SKILL.md`, name));

const files: Covered[] = [
  ...skillsIn("kit/skills"),
  ...skillsIn("kit-blueprint/skills"),
  ...markdown("kit/agents").map((file) => covered(`kit/agents/${file}`, basename(file, ".md"))),
  covered(".claude/skills/audit-ai-guidelines/SKILL.md", "audit-ai-guidelines"),
];

const nameFits = ({ name, content }: Covered): boolean => {
  const given = frontmatterOf(content).get("name") ?? "";
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(given) && given === name;
};

const descriptionFits = ({ content }: Covered): boolean => {
  const description = frontmatterOf(content).get("description") ?? "";
  return description.length >= 60 && /\b(?:when|before|after)\b/i.test(description);
};

const bodyLimit = 200;

const lengthFits = ({ content }: Covered): boolean =>
  bodyOf(content).trimEnd().split("\n").length <= bodyLimit;

const ticketFree = ({ content }: Covered): boolean => !/\bFD-\d+\b/.test(content);

const checks = [
  ["names itself after its folder or file", nameFits],
  ["has a description of at least 60 characters that says when to use it", descriptionFits],
  [`has a body of at most ${bodyLimit} lines`, lengthFits],
  ["carries no ticket id", ticketFree],
] as const;

const failing = (fits: (file: Covered) => boolean) =>
  files.filter((file) => !fits(file)).map((file) => file.path);

const broken = (file: Covered, content: string): Covered => ({ ...file, content });

const reference = files.find((file) => file.path === "kit-blueprint/skills/blueprint/SKILL.md");

const breakages: [string, (file: Covered) => boolean, (file: Covered) => Covered][] = [
  [
    "a renamed skill",
    nameFits,
    (file) => broken(file, file.content.replace(/^name: .*$/m, `name: ${file.name}-renamed`)),
  ],
  [
    "a description that never says when",
    descriptionFits,
    (file) =>
      broken(
        file,
        file.content.replace(/^description: .*$/m, (line) =>
          line.replace(/\b(?:when|before|after)\b/gi, "then"),
        ),
      ),
  ],
  [
    "a body too long to read in full",
    lengthFits,
    (file) => broken(file, `${file.content}${"padding\n".repeat(bodyLimit)}`),
  ],
  ["a ticket id", ticketFree, (file) => broken(file, `${file.content}\nSee FD-1.\n`)],
];

describe("every shipped skill, kit agent and the repo audit skill", () => {
  it("covers both kits, the kit agents and the repo audit skill", () => {
    const paths = files.map((file) => file.path);

    expect(paths.filter((path) => path.startsWith("kit/skills/")).length).toBeGreaterThan(0);
    expect(paths).toContain("kit-blueprint/skills/blueprint/SKILL.md");
    expect(paths).toContain("kit/agents/piece-auditor.md");
    expect(paths).toContain("kit/agents/handoff-auditor.md");
    expect(paths).toContain(".claude/skills/audit-ai-guidelines/SKILL.md");
  });

  it.each(checks)("%s", (_, fits) => {
    expect(failing(fits)).toEqual([]);
  });

  it.each(breakages)("rejects %s", (_, fits, breakIt) => {
    expect(reference).toBeDefined();
    if (reference === undefined) return;

    expect(fits(reference)).toBe(true);
    expect(fits(breakIt(reference))).toBe(false);
  });
});
