import { describe, expect, it } from "vitest";
import { compilePrompt } from "../../../../src/core/nodes/prompt/compile.js";

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

describe("compilePrompt", () => {
  it("writes a command file with the label as its description", () => {
    expect(compilePrompt(promptNode("Plan it", { instructions: "Write the plan." }))).toEqual({
      path: "plugin/commands/plan.md",
      content: '---\ndescription: "Plan it"\n---\nWrite the plan.\n',
    });
  });

  it("keeps a label with YAML-special characters on one quoted line", () => {
    const { content } = compilePrompt(promptNode('a: b # "c"\nd', { instructions: "Go." }));

    expect(content).toBe('---\ndescription: "a: b # \\"c\\"\\nd"\n---\nGo.\n');
  });

  it("ends the command file with the expected output", () => {
    const { content } = compilePrompt(
      promptNode("Plan it", { instructions: "Write the plan.", expectedOutput: "plan.md exists" }),
    );

    expect(content).toBe(
      '---\ndescription: "Plan it"\n---\nWrite the plan.\n\nExpected output: plan.md exists\n',
    );
  });

  it.each(["", "  "])("adds no expected output line for %j", (expectedOutput) => {
    const { content } = compilePrompt(
      promptNode("Plan it", { instructions: "Write the plan.", expectedOutput }),
    );

    expect(content).toBe('---\ndescription: "Plan it"\n---\nWrite the plan.\n');
  });

  it("fills the build's values into the instructions", () => {
    expect(
      compilePrompt(
        promptNode("Fix it", { instructions: "Fix {{ticket}}" }),
        { given: [], writes: [] },
        { ticket: "FD-99" },
      ),
    ).toEqual({
      path: "plugin/commands/plan.md",
      content: '---\ndescription: "Fix it"\n---\nFix FD-99\n',
    });
  });

  it("ends the command file with the files it is given and the files it writes", () => {
    const { content } = compilePrompt(
      promptNode("Plan it", { instructions: "Write the plan.", expectedOutput: "a plan" }),
      { given: ["ticket.md"], writes: ["plan.md", "notes.md"] },
    );

    expect(content).toBe(
      '---\ndescription: "Plan it"\n---\nWrite the plan.\n\nExpected output: a plan\n\nYou are given: ticket.md\nWrite: plan.md, notes.md\n',
    );
  });
});
