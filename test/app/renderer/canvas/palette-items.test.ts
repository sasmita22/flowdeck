import { describe, expect, it } from "vitest";
import {
  filterPalette,
  groupPalette,
  nodeTitle,
  noteTitle,
  paletteGroups,
  paletteItems,
} from "../../../../src/app/renderer/canvas/palette-items.js";
import { nodeDefaults } from "../../../../src/app/renderer/canvas/store.js";
import { nodeLook } from "../../../../src/app/renderer/nodes/look.js";
import { paletteTestId } from "../../../../src/app/renderer/test-ids.js";
import { NodeType } from "../../../../src/core/flow/schema.js";

const itemOf = (type: NodeType | "note") => {
  const item = paletteItems.find((entry) => entry.type === type);
  if (item === undefined) throw new Error(`no palette item for ${type}`);
  return item;
};

describe("nodeTitle", () => {
  it.each(NodeType.options)("names %s and says what it does, as the sidebar does", (type) => {
    const { label, description } = itemOf(type);
    expect(nodeTitle(type)).toBe(`${label}: ${description}`);
  });
});

describe("paletteItems", () => {
  it("has one entry per node type, and the note", () => {
    expect(paletteItems.map((item) => item.type).sort()).toEqual(
      [...NodeType.options, "note"].sort(),
    );
  });

  it.each(NodeType.options)("draws %s from its test id, defaults and look", (type) => {
    expect(itemOf(type)).toMatchObject({
      testId: paletteTestId(type),
      label: nodeDefaults[type].label,
      tag: nodeLook(type).tag,
      color: nodeLook(type).group,
    });
  });

  it.each(NodeType.options)("puts %s in one of the design's six node groups", (type) => {
    expect(paletteGroups.slice(0, 6)).toContain(itemOf(type).group);
  });

  it.each(NodeType.options)("describes %s in one non-empty line", (type) => {
    const { description } = itemOf(type);
    expect(description.trim()).not.toBe("");
    expect(description).not.toMatch(/\n/);
  });

  it("names the six node groups in the design's order, then Canvas", () => {
    expect(paletteGroups).toEqual([
      "Composition",
      "Work",
      "Control",
      "People and safety",
      "Run events",
      "In and out",
      "Canvas",
    ]);
  });

  it("puts the note alone in the Canvas group, as a plain-words entry", () => {
    expect(paletteItems.filter((item) => item.group === "Canvas")).toEqual([
      {
        type: "note",
        testId: "palette-note",
        label: "Note",
        tag: "NOTE",
        color: "var(--c-ctrl)",
        group: "Canvas",
        description: "Canvas-only text. It never runs.",
      },
    ]);
  });
});

describe("filterPalette", () => {
  it.each(["", "   "])("returns every entry for the query %j", (query) => {
    expect(filterPalette(paletteItems, query)).toEqual(paletteItems);
  });

  it("matches labels without regard to case", () => {
    expect(filterPalette(paletteItems, "LOOP").map((item) => item.type)).toEqual(["loop"]);
  });

  it("matches group names", () => {
    expect(
      filterPalette(paletteItems, "people")
        .map((item) => item.type)
        .sort(),
    ).toEqual(
      paletteItems
        .filter((item) => item.group === "People and safety")
        .map((item) => item.type)
        .sort(),
    );
  });

  it("returns nothing when nothing matches", () => {
    expect(filterPalette(paletteItems, "zzz")).toEqual([]);
  });
});

describe("noteTitle", () => {
  it("says a note is canvas-only text that never runs", () => {
    expect(noteTitle).toBe("Note: canvas-only text. It never runs.");
  });
});

describe("filterPalette finds the note", () => {
  it.each(["note", "canvas"])("for %j", (query) => {
    expect(filterPalette(paletteItems, query).map((item) => item.type)).toEqual(["note"]);
  });
});

describe("groupPalette", () => {
  it("lists groups in the design's order and leaves out empty ones", () => {
    const grouped = groupPalette(paletteItems);
    const names = grouped.map(({ group }) => group);

    expect(names).toEqual(paletteGroups.filter((group) => names.includes(group)));
    expect(grouped.every(({ items }) => items.length > 0)).toBe(true);
    expect(grouped.flatMap(({ items }) => items)).toHaveLength(paletteItems.length);
  });

  it("keeps only the groups that hold a match", () => {
    expect(groupPalette(filterPalette(paletteItems, "loop"))).toEqual([
      { group: "Control", items: [itemOf("loop")] },
    ]);
  });
});

describe("the Branch entry", () => {
  it("says it follows a Trigger flag, and promises no verdict", () => {
    const { description } = itemOf("branch");

    expect(description).toMatch(/Trigger/);
    expect(description).toMatch(/flag/);
    expect(description).not.toMatch(/verdict/i);
  });
});
