import { describe, expect, it } from "vitest";
import { handoffTemplates } from "../../../src/core/compiler/handoff-templates.js";
import { agent, fileWire, flow, thenWire } from "../../fixtures/flow-builders.js";

const sample = () =>
  flow(
    [
      agent("s", { settings: { command: "npm" } }),
      agent("plan", { settings: { tools: [] } }),
      agent("review", { settings: { tools: [] } }),
      agent("p"),
    ],
    [
      thenWire("s", "plan"),
      thenWire("plan", "review"),
      fileWire("s", "plan", "notes/plan.md"),
      fileWire("s", "review", "notes/plan.md"),
      fileWire("plan", "review", "review.md"),
    ],
  );

const sections = (content: string) => content.split("\n").filter((line) => line.startsWith("## "));

describe("handoffTemplates", () => {
  it("writes one template per distinct file a File wire carries", () => {
    expect(handoffTemplates(sample(), "carousell-web").map((file) => file.path)).toEqual([
      "plugin/templates/notes/plan.md",
      "plugin/templates/review.md",
    ]);
  });

  it("writes none for a File-wire file that is not markdown", () => {
    const plain = flow(
      [agent("w", { settings: { tools: [] } }), agent("r", { settings: { tools: [] } })],
      [
        thenWire("w", "r"),
        fileWire("w", "r", "greeting.txt"),
        fileWire("w", "r", "data.json"),
        fileWire("w", "r", "notes.md"),
      ],
    );

    expect(handoffTemplates(plain, "carousell-web").map((file) => file.path)).toEqual([
      "plugin/templates/notes.md",
    ]);
  });

  it("writes none when no File wire carries a file", () => {
    expect(handoffTemplates(flow([agent("p")], []), "carousell-web")).toEqual([]);
  });

  it("opens each template with an @template line and never an @unfilled one", () => {
    for (const { content } of handoffTemplates(sample(), "carousell-web")) {
      expect(content.split("\n")[0]).toMatch(/^@template\b/);
      expect(content).not.toContain("@unfilled");
    }
  });

  it("names where the real file goes: the bare file in the run's working folder, which sits at the repo folder in the workspace", () => {
    const [plan = "", review = ""] = handoffTemplates(sample(), "carousell-web").map(
      (file) => file.content,
    );

    expect(plan.split("\n")[0]).toContain(
      "`notes/plan.md` in the run's working folder (`carousell-web/` in the workspace)",
    );
    expect(review.split("\n")[0]).toContain(
      "`review.md` in the run's working folder (`carousell-web/` in the workspace)",
    );
    expect(plan).not.toContain("carousell-web/notes/plan.md");
    expect(review).not.toContain("carousell-web/review.md");
  });

  it("names the nodes that write and read the file", () => {
    const [plan = "", review = ""] = handoffTemplates(sample(), "carousell-web").map(
      (file) => file.content,
    );

    expect(plan).toMatch(/Written by: NODE s\b/);
    expect(plan).toMatch(/Read by: NODE plan, NODE review\b/);
    expect(review).toMatch(/Written by: NODE plan\b/);
    expect(review).toMatch(/Read by: NODE review\b/);
  });

  it("gives every template the same fixed sections", () => {
    const [plan = "", review = ""] = handoffTemplates(sample(), "carousell-web").map(
      (file) => file.content,
    );

    expect(sections(plan).length).toBeGreaterThan(0);
    expect(sections(review)).toEqual(sections(plan));
  });

  it("gives the same templates for the same flow", () => {
    expect(handoffTemplates(sample(), "carousell-web")).toStrictEqual(
      handoffTemplates(sample(), "carousell-web"),
    );
  });
});
