import { describe, expect, it } from "vitest";
import { scopeLine } from "../../../../src/core/compiler/scope-line.js";
import { compilePrompt } from "../../../../src/core/nodes/prompt/compile.js";
import { bodyOf, frontmatter, sectionOf } from "../../../fixtures/frontmatter.js";
import { expectBareHandoffRule, nestedHandoffPaths } from "../../../fixtures/handoff.js";

const scope = { build: "fix-login", repo: "carousell-web", workspace: "/fd/workspaces/b1" };
const piece = "plan-it";

const promptNode = (
  label: string,
  settings: { instructions: string; expectedOutput?: string },
) => ({
  id: "plan",
  type: "prompt" as const,
  label,
  position: { x: 0, y: 0 },
  settings,
});

const compiled = (
  node = promptNode("Plan it", { instructions: "Write the plan." }),
  more: Partial<Parameters<typeof compilePrompt>[1]> = {},
) => compilePrompt(node, { piece, scope, ...more });

const lines = (content: string) => bodyOf(content).split("\n");

describe("compilePrompt", () => {
  it("writes the step skill plugin/skills/<piece>/SKILL.md, and nothing under plugin/commands/", () => {
    const { path } = compiled();

    expect(path).toBe("plugin/skills/plan-it/SKILL.md");
    expect(path).not.toMatch(/^plugin\/commands\//);
  });

  it("names the skill with its piece, opens its description with the scope line, and keeps the model from calling it", () => {
    const fields = frontmatter(compiled().content);

    expect(fields.name).toBe("plan-it");
    expect(String(fields.description).startsWith(scopeLine(scope))).toBe(true);
    expect(fields["disable-model-invocation"]).toBe(true);
  });

  it("keeps a label with YAML-special characters inside one quoted frontmatter line", () => {
    const fields = frontmatter(
      compiled(promptNode('a: b # "c"\nd', { instructions: "Go." })).content,
    );

    expect(fields.name).toBe("plan-it");
    expect(String(fields.description).startsWith(scopeLine(scope))).toBe(true);
  });

  it("marks the body as a draft with an @unfilled line", () => {
    expect(lines(compiled().content).some((line) => line.startsWith("@unfilled"))).toBe(true);
  });

  it("carries the instructions, with the build's values filled in", () => {
    const body = bodyOf(
      compiled(promptNode("Fix it", { instructions: "Fix {{ticket}}" }), {
        values: { ticket: "FD-99" },
      }).content,
    );

    expect(body).toContain("Fix FD-99");
    expect(body).not.toContain("{{ticket}}");
  });

  it("has a section on what it builds on, naming the files it is given", () => {
    const { content } = compiled(undefined, {
      wired: { given: ["ticket.md"], writes: ["plan.md", "notes.md"] },
    });

    expect(sectionOf(content, /builds on/i)).toContain("ticket.md");
  });

  it("has a section on what it leaves behind, naming the files it writes", () => {
    const { content } = compiled(undefined, {
      wired: { given: ["ticket.md"], writes: ["plan.md", "notes.md"] },
    });

    expect(sectionOf(content, /leaves behind/i)).toMatch(/plan\.md[\s\S]*notes\.md/);
  });

  it("says under Builds on that hand-off files are named bare in the run's working folder, which sits at the repo folder in the workspace", () => {
    const wired = { given: ["plan.md", "ticket.md"], writes: ["notes.md"] };
    const content = compiled(undefined, { wired }).content;

    expectBareHandoffRule(sectionOf(content, /builds on/i), "carousell-web");
    expect(nestedHandoffPaths(content, "carousell-web", [...wired.given, ...wired.writes])).toEqual(
      [],
    );
  });

  it("has both sections even when no wire carries a file", () => {
    const headings = lines(compiled().content).filter((line) => line.startsWith("## "));

    expect(headings.some((line) => /builds on/i.test(line))).toBe(true);
    expect(headings.some((line) => /leaves behind/i.test(line))).toBe(true);
  });

  it("carries the expected output", () => {
    const { content } = compiled(
      promptNode("Plan it", { instructions: "Write the plan.", expectedOutput: "plan.md exists" }),
    );

    expect(bodyOf(content)).toContain("plan.md exists");
  });

  it.each(["", "  "])("adds no expected output line for %j", (expectedOutput) => {
    const { content } = compiled(
      promptNode("Plan it", { instructions: "Write the plan.", expectedOutput }),
    );

    expect(bodyOf(content)).not.toContain("Expected output");
  });
});
