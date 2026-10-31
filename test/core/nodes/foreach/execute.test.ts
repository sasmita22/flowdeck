import { describe, expect, it } from "vitest";
import {
  firstTurnId,
  listItems,
  listPath,
  withItem,
} from "../../../../src/core/nodes/foreach/execute.js";
import { agent, flow, gate, prompt, script } from "../../../fixtures/flow-builders.js";

const lines = (...text: string[]) => text.join("\n");

describe("listItems", () => {
  it("reads three units in file order, ignoring the heading and prose", () => {
    const plan = lines("# Plan", "", "The units to build.", "", "- alpha", "- bravo", "- charlie");

    expect(listItems(plan)).toEqual(["alpha", "bravo", "charlie"]);
  });

  it.each([
    ["an empty file", ""],
    ["a heading-only file", "# Plan\n"],
    ["a prose-only file", lines("Some prose.", "", "More prose.")],
  ])("finds no items in %s", (_, markdown) => {
    expect(listItems(markdown)).toEqual([]);
  });

  it.each(["* unit", "+ unit", "1. unit", "2) unit"])("strips the marker of %j", (line) => {
    expect(listItems(line)).toEqual(["unit"]);
  });

  it("keeps a checkbox as text", () => {
    expect(listItems("- [ ] unit")).toEqual(["[ ] unit"]);
  });

  it("joins indented continuation and nested lines to their item", () => {
    expect(listItems(lines("- a", "  continued", "  - sub"))).toEqual(["a continued - sub"]);
  });

  it("keeps two items apart across a blank line", () => {
    expect(listItems(lines("- a", "", "- b"))).toEqual(["a", "b"]);
  });

  it("joins an unindented line straight under an item to that item", () => {
    expect(listItems(lines("- a", "lazy", "- b"))).toEqual(["a lazy", "b"]);
  });

  it("ends the list at a heading straight under an item", () => {
    expect(listItems(lines("- a", "- b", "## Notes", "prose"))).toEqual(["a", "b"]);
  });

  it.each(["```", "~~~", "> quote", "---", "***", "___"])(
    "never joins %j straight under an item",
    (line) => {
      expect(listItems(lines("- a", line, "prose"))).toEqual(["a"]);
    },
  );

  it("ignores list markers inside a fenced code block", () => {
    const plan = "- alpha\n- bravo\n\n```diff\n- old line\n+ new line\n```\n";

    expect(listItems(plan)).toEqual(["alpha", "bravo"]);
  });

  it("never joins an indented fence or its contents to the open item", () => {
    expect(listItems(lines("- a", "  ```ts", "  - x", "  ```", "- b"))).toEqual(["a", "b"]);
  });

  it("keeps joining an item's lines after its indented fence", () => {
    expect(
      listItems(
        lines(
          "- Unit 1: add X",
          "  ```ts",
          "  const a = 1;",
          "  ```",
          "  Then test Y.",
          "  - sub after",
          "- Unit 2",
        ),
      ),
    ).toEqual(["Unit 1: add X Then test Y. - sub after", "Unit 2"]);
  });

  it("keeps a fence open past a shorter inner fence", () => {
    expect(listItems(lines("- a", "", "````md", "```", "- x", "```", "````", "- b"))).toEqual([
      "a",
      "b",
    ]);
  });

  it("ends an item at a blank line followed by an unindented paragraph", () => {
    expect(listItems(lines("- a", "", "Afterword.", "- b"))).toEqual(["a", "b"]);
  });
});

describe("withItem", () => {
  it("appends the round's item to the turn", () => {
    expect(withItem("/abc:p1", "alpha")).toBe("/abc:p1 This round's item: alpha");
  });
});

describe("listPath", () => {
  it("resolves the list file against the run folder", () => {
    expect(listPath("/repo", "docs/plan.md")).toBe("/repo/docs/plan.md");
  });
});

describe("firstTurnId", () => {
  const body = (nodes: unknown[]) => flow(nodes, []).nodes;

  it("skips non-turn nodes to the first prompt", () => {
    expect(firstTurnId(body([script("s1"), prompt("p1"), agent("a1")]))).toBe("p1");
  });

  it("names an agent that comes before the prompt", () => {
    expect(firstTurnId(body([agent("a1"), prompt("p1")]))).toBe("a1");
  });

  it("is undefined for a body with no prompt or agent", () => {
    expect(firstTurnId(body([script("s1"), gate("g1")]))).toBeUndefined();
  });
});
