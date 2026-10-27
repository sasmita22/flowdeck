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
      path: "commands/plan.md",
      content: '---\ndescription: "Plan it"\n---\nWrite the plan.\n',
    });
  });

  it("keeps a label with YAML-special characters on one quoted line", () => {
    const { content } = compilePrompt(promptNode('a: b # "c"\nd', { instructions: "Go." }));

    expect(content).toBe('---\ndescription: "a: b # \\"c\\"\\nd"\n---\nGo.\n');
  });

  it("leaves the expected output out of the command file", () => {
    const { content } = compilePrompt(
      promptNode("Plan it", { instructions: "Write the plan.", expectedOutput: "plan.md exists" }),
    );

    expect(content).toBe('---\ndescription: "Plan it"\n---\nWrite the plan.\n');
  });
});
