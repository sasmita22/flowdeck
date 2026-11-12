import { describe, expect, it } from "vitest";
import { handoffTemplates } from "../../../src/core/compiler/handoff-templates.js";
import { agent, flow, thenWire } from "../../fixtures/flow-builders.js";

const handing = (id: string, given: string[], writes: string[]) =>
  agent(id, { settings: { tools: [], given, writes } });

const sample = () =>
  flow(
    [
      handing("s", [], ["notes/plan.md"]),
      handing("plan", ["notes/plan.md"], ["review.md"]),
      handing("review", ["notes/plan.md", "review.md"], []),
      agent("p"),
    ],
    [thenWire("s", "plan"), thenWire("plan", "review")],
  );

const paths = (files: { path: string }[]) => files.map((file) => file.path);

const sections = (content: string) => content.split("\n").filter((line) => line.startsWith("## "));

describe("handoffTemplates", () => {
  it("writes one template per distinct file one Agent writes and another is given", () => {
    expect(paths(handoffTemplates(sample(), "carousell-web"))).toEqual([
      "plugin/templates/notes/plan.md",
      "plugin/templates/review.md",
    ]);
  });

  it("writes none for a hand-off file that is not markdown", () => {
    const files = ["greeting.txt", "data.json", "notes.md"];
    const plain = flow([handing("w", [], files), handing("r", files, [])], [thenWire("w", "r")]);

    expect(paths(handoffTemplates(plain, "carousell-web"))).toEqual(["plugin/templates/notes.md"]);
  });

  it.each([
    ["a given file no other Agent writes", handing("r", ["ticket.md"], [])],
    ["a written file no other Agent is given", handing("w", [], ["report.md"])],
    ["a file one Agent is given and writes itself", handing("e", ["notes.md"], ["notes.md"])],
  ])("writes none for %s", (_, node) => {
    expect(handoffTemplates(flow([node], []), "carousell-web")).toEqual([]);
  });

  it("writes none when no Agent hands on a file", () => {
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

    expect(plan).toMatch(/Written by: NODE s\n/);
    expect(plan).toMatch(/Read by: NODE plan, NODE review\n/);
    expect(review).toMatch(/Written by: NODE plan\n/);
    expect(review).toMatch(/Read by: NODE review\n/);
  });

  it("names every writer of a file several Agents write", () => {
    const shared = flow(
      [handing("a", [], ["plan.md"]), handing("b", [], ["plan.md"]), handing("r", ["plan.md"], [])],
      [thenWire("a", "b"), thenWire("b", "r")],
    );
    const [plan = ""] = handoffTemplates(shared, "carousell-web").map((file) => file.content);

    expect(plan).toMatch(/Written by: NODE a, NODE b\n/);
    expect(plan).toMatch(/Read by: NODE r\n/);
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
