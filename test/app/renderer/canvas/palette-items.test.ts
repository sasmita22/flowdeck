import { describe, expect, it } from "vitest";
import {
  filterLibraries,
  filterPalette,
  flowContainerItems,
  groupPalette,
  libraryEntryAria,
  libraryItems,
  libraryReasonId,
  nodeTitle,
  type LibraryItem,
  noteTitle,
  paletteEntryAria,
  paletteGroups,
  paletteItems,
} from "../../../../src/app/renderer/canvas/palette-items.js";
import {
  isCanvasItemType,
  newCanvasFlow,
  nodeDefaults,
  type CanvasItemType,
} from "../../../../src/app/renderer/canvas/store.js";
import { nodeLook } from "../../../../src/app/renderer/nodes/look.js";
import { libraryTestIds, paletteTestId } from "../../../../src/app/renderer/test-ids.js";
import type { FlowSummary } from "../../../../src/core/flow/flow-store.js";
import { NodeType, type Flow } from "../../../../src/core/flow/schema.js";
import { agent, flow, flowSettings, sessionContainer } from "../../../fixtures/flow-builders.js";

const placeable = NodeType.exclude(["library"]).options;

const itemOf = (type: CanvasItemType) => {
  const item = paletteItems.find((entry) => entry.type === type);
  if (item === undefined) throw new Error(`no palette item for ${type}`);
  return item;
};

describe("nodeTitle", () => {
  it.each(placeable)("names %s and says what it does, as the sidebar does", (type) => {
    const { label, description } = itemOf(type);
    expect(nodeTitle(type)).toBe(`${label}: ${description}`);
  });
});

describe("paletteItems", () => {
  it("has one entry per node type but library, the two containers, and the note", () => {
    expect(paletteItems.map((item) => item.type).sort()).toEqual(
      [...placeable, "workspace", "session", "note"].sort(),
    );
  });

  it("offers Loop and nothing that runs a body once per item", () => {
    const types: string[] = paletteItems.map((item) => item.type);
    expect(types).toContain("loop");
    expect(types).not.toContain("foreach");
  });

  it("offers no bare library entry; libraries come from saved blueprints", () => {
    expect(paletteItems.map((item) => item.type)).not.toContain("library");
  });

  it.each(placeable)("draws %s from its test id, defaults and look", (type) => {
    expect(itemOf(type)).toMatchObject({
      testId: paletteTestId(type),
      label: nodeDefaults[type].label,
      tag: nodeLook(type).tag,
      color: nodeLook(type).group,
    });
  });

  it.each(placeable)("puts %s in one of the design's six node groups", (type) => {
    expect(paletteGroups.slice(0, 6)).toContain(itemOf(type).group);
  });

  it.each(placeable)("describes %s in one non-empty line", (type) => {
    const { description } = itemOf(type);
    expect(description.trim()).not.toBe("");
    expect(description).not.toMatch(/\n/);
  });

  it("offers Agent as the only Work entry, and no Prompt or Script", () => {
    expect(paletteItems.filter((item) => item.group === "Work").map((item) => item.type)).toEqual([
      "agent",
    ]);
    expect(paletteItems.map((item) => item.testId)).not.toEqual(
      expect.arrayContaining(["palette-prompt"]),
    );
    expect(paletteItems.map((item) => item.testId)).not.toEqual(
      expect.arrayContaining(["palette-script"]),
    );
  });

  it("leads with a headingless group, then the node groups in the design's order, then Canvas", () => {
    expect(paletteGroups).toEqual([
      "",
      "Composition",
      "Work",
      "Control",
      "People and safety",
      "Run events",
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

describe("paletteEntryAria", () => {
  it.each(paletteItems)("makes $label a button named by its label", (item) => {
    expect(item.label.trim()).not.toBe("");
    expect(paletteEntryAria(item)).toEqual({ role: "button", "aria-label": item.label });
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
  it("says it follows a yes/no variable, and promises no verdict", () => {
    const { description } = itemOf("branch");

    expect(description).toMatch(/yes\/no variable/);
    expect(description).not.toMatch(/Trigger|flag/);
    expect(description).not.toMatch(/verdict/i);
  });
});

describe("the Gate entry", () => {
  it("says it pauses to show its Instruction, always or only when its condition is met", () => {
    const { description } = itemOf("gate");

    expect(description).toMatch(/Instruction/);
    expect(description).toMatch(/Always/);
    expect(description).toMatch(/Conditional/);
    expect(description).not.toMatch(/approve|flag/i);
  });

  it.each(["hardstop", "ask"])("is the only People and safety row: no %s row", (type) => {
    expect(paletteItems.map((item) => item.type as string)).not.toContain(type);
    expect(
      paletteItems.filter((item) => item.group === "People and safety").map((item) => item.type),
    ).toEqual(["gate"]);
  });
});

describe("the Start entry", () => {
  it("says it is where the blueprint starts and what the main flow is", () => {
    expect(itemOf("trigger").description).toBe(
      "Where the blueprint starts. Everything wired from here is the main flow.",
    );
  });
});

describe("the Stop entry", () => {
  it("says it is where the main flow ends and what it hands back", () => {
    expect(itemOf("output").description).toBe("Where the main flow ends, and what it hands back.");
  });
});

describe("Start and Stop on top", () => {
  const typesOf = (query: string) => filterPalette(paletteItems, query).map((item) => item.type);

  it("puts Start then Stop in a headingless group ahead of every named group", () => {
    const [first, ...rest] = groupPalette(filterPalette(paletteItems, ""));

    expect(first).toEqual({ group: "", items: [itemOf("trigger"), itemOf("output")] });
    expect(rest.map(({ group }) => group as string)).not.toContain("");
  });

  it("no longer has an In and out group", () => {
    expect(paletteItems.map((item) => item.group as string)).not.toContain("In and out");
    expect(groupPalette(paletteItems).map(({ group }) => group as string)).not.toContain(
      "In and out",
    );
  });

  it("finds only Stop when searching for stop", () => {
    expect(typesOf("stop")).toEqual(["output"]);
    expect(groupPalette(filterPalette(paletteItems, "stop"))[0]).toEqual({
      group: "",
      items: [itemOf("output")],
    });
  });

  it("keeps Start and Stop first when searching for s", () => {
    expect(typesOf("s").slice(0, 2)).toEqual(["trigger", "output"]);
  });
});

describe("the Composition group", () => {
  it("holds Workspace then Session, each with its palette id", () => {
    expect(
      paletteItems
        .filter((item) => item.group === "Composition")
        .map(({ type, testId, label }) => ({ type, testId, label })),
    ).toEqual([
      { type: "workspace", testId: "palette-workspace", label: "Workspace" },
      { type: "session", testId: "palette-session", label: "Session" },
    ]);
  });

  it.each(["workspace", "session"])("counts %s as a canvas item type", (type) => {
    expect(isCanvasItemType(type)).toBe(true);
  });

  it.each(["workspace", "session"] as const)("describes %s in one non-empty line", (type) => {
    const { description } = itemOf(type);
    expect(description.trim()).not.toBe("");
    expect(description).not.toMatch(/\n/);
  });
});

describe("flowContainerItems", () => {
  const at = { x: 400, y: 300 };

  const onlyContainer = (items: ReturnType<typeof flowContainerItems>) => {
    const [container, ...more] = items.containers ?? [];
    if (container === undefined || more.length > 0) throw new Error("expected one container");
    return container;
  };

  const wiredStartAndStop = (source: Flow, items: ReturnType<typeof flowContainerItems>) => {
    const container = onlyContainer(items);
    const [start, stop, ...rest] = items.nodes;
    expect(rest).toEqual([]);
    expect(start?.type).toBe("trigger");
    expect(stop?.type).toBe("output");
    expect(container.nodes).toEqual([start?.id, stop?.id]);
    expect(items.nodes.some((node) => node.parent !== undefined)).toBe(false);
    const taken = new Set([
      ...source.nodes.map(({ id }) => id),
      ...source.containers.map(({ id }) => id),
    ]);
    expect(items.nodes.filter(({ id }) => taken.has(id) || id === container.id)).toEqual([]);
    expect(items.wires).toEqual([
      {
        kind: "then",
        from: { node: start?.id, port: "out" },
        to: { node: stop?.id, port: "in" },
      },
    ]);
    expect(items.notes).toEqual([]);
  };

  it("makes a Session a session container with the next free id and name, holding a wired Start and Stop", () => {
    const source = newCanvasFlow();

    const items = flowContainerItems("session", source, at);

    expect(onlyContainer(items)).toMatchObject({
      id: "session-2",
      kind: "session",
      name: "session-2",
      repo: "",
      branch: "",
      model: "sonnet",
    });
    wiredStartAndStop(source, items);
  });

  it("names a Session after the names already taken", () => {
    const source = flow([agent("a"), agent("b")], [], flowSettings, {
      containers: [
        sessionContainer(["a"], { name: "session" }),
        sessionContainer(["b"], { id: "session-2", name: "session-2" }),
      ],
    });

    expect(onlyContainer(flowContainerItems("session", source, at))).toMatchObject({
      id: "session-3",
      name: "session-3",
    });
  });

  it("names the first Session session, as session-1", () => {
    const source = flow([], [], flowSettings, { containers: [] });

    expect(onlyContainer(flowContainerItems("session", source, at))).toMatchObject({
      id: "session-1",
      name: "session",
    });
  });

  it("makes a Workspace a workspace container on sonnet, holding a wired Start and Stop", () => {
    const source = flow([agent("a")], [], flowSettings, {
      containers: [sessionContainer(["a"])],
    });

    const items = flowContainerItems("workspace", source, at);

    expect(onlyContainer(items)).toEqual({
      id: "workspace-1",
      kind: "workspace",
      model: "sonnet",
      nodes: onlyContainer(items).nodes,
    });
    wiredStartAndStop(source, items);
  });
});

describe("libraryItems", () => {
  const summary = (
    flowId: string,
    name: string,
    kind: FlowSummary["kind"],
    uses: string[] = [],
  ): FlowSummary => ({
    flowId,
    name,
    createdAt: "2026-01-01T00:00:00.000Z",
    versions: 1,
    lastSavedAt: "2026-01-01T00:00:00.000Z",
    buildConfig: null,
    variables: [],
    pinned: false,
    kind,
    sessions: [],
    uses,
    sends: [],
  });

  const summaries = [
    summary("f-review", "Review", "node-library"),
    summary("f-android", "Android", "session-library"),
    summary("f-host", "Host", "workflow"),
    summary("f-empty", "Empty", "incomplete"),
    summary("f-open", "Open one", "node-library"),
  ];

  it("lists node and session libraries by name and kind, each with its palette id", () => {
    expect(libraryItems(summaries, "f-open")).toEqual([
      {
        flowId: "f-review",
        testId: libraryTestIds.paletteItem("f-review"),
        label: "Review",
        kind: "node-library",
        kindLabel: "Node library",
        loop: null,
      },
      {
        flowId: "f-android",
        testId: libraryTestIds.paletteItem("f-android"),
        label: "Android",
        kind: "session-library",
        kindLabel: "Session library",
        loop: null,
      },
    ]);
  });

  const loopOf = (items: readonly LibraryItem[], flowId: string) =>
    items.find((item) => item.flowId === flowId)?.loop;

  it("gives a library that uses the open blueprint the loop path as its reason", () => {
    const items = libraryItems(
      [
        summary("b", "LibB", "node-library"),
        summary("a", "LibA", "node-library", ["b"]),
        summary("c", "LibC", "node-library"),
      ],
      "b",
    );

    expect(loopOf(items, "a")).toBe("makes a loop: LibB → LibA → LibB");
    expect(loopOf(items, "c")).toBeNull();
    expect(items.map(({ flowId }) => flowId)).toEqual(["a", "c"]);
  });

  const loopCase = () =>
    libraryItems(
      [
        summary("b", "LibB", "node-library"),
        summary("a", "LibA", "node-library", ["b"]),
        summary("c", "LibC", "node-library"),
      ],
      "b",
    );

  const entryOf = (items: readonly LibraryItem[], flowId: string) => {
    const item = items.find((entry) => entry.flowId === flowId);
    if (item === undefined) throw new Error(`no library item for ${flowId}`);
    return item;
  };

  it("makes a library that is not greyed an enabled button named by its label, with no description", () => {
    expect(libraryEntryAria(entryOf(loopCase(), "c"))).toEqual({
      role: "button",
      "aria-label": "LibC",
      "aria-disabled": false,
    });
  });

  it("makes a greyed library a disabled button described by its loop reason", () => {
    expect(libraryEntryAria(entryOf(loopCase(), "a"))).toEqual({
      role: "button",
      "aria-label": "LibA",
      "aria-disabled": true,
      "aria-describedby": libraryReasonId("a"),
    });
    expect(libraryReasonId("a")).toBe("palette-lib-reason-a");
  });

  it("keeps a library already in a loop listed for an unrelated blueprint, with its loop", () => {
    const items = libraryItems(
      [
        summary("p", "LoopP", "node-library", ["q"]),
        summary("q", "LoopQ", "node-library", ["p"]),
        summary("y", "Plain", "workflow"),
      ],
      "y",
    );

    expect(loopOf(items, "p")).toBe("makes a loop: LoopP → LoopQ → LoopP");
    expect(loopOf(items, "q")).toBe("makes a loop: LoopQ → LoopP → LoopQ");
  });

  it("leaves out the open blueprint itself", () => {
    expect(libraryItems(summaries, "f-review").map(({ flowId }) => flowId)).toEqual([
      "f-android",
      "f-open",
    ]);
  });

  it("lists every library when no blueprint is open", () => {
    expect(libraryItems(summaries, null).map(({ flowId }) => flowId)).toEqual([
      "f-review",
      "f-android",
      "f-open",
    ]);
  });
});

describe("filterLibraries", () => {
  const items = [
    {
      flowId: "f-review",
      testId: libraryTestIds.paletteItem("f-review"),
      label: "Review",
      kind: "node-library" as const,
      kindLabel: "Node library",
      loop: null,
    },
    {
      flowId: "f-android",
      testId: libraryTestIds.paletteItem("f-android"),
      label: "Android",
      kind: "session-library" as const,
      kindLabel: "Session library",
      loop: null,
    },
  ];

  it.each(["", "  ", "libraries"])("keeps every library for %j", (query) => {
    expect(filterLibraries(items, query)).toEqual(items);
  });

  it("matches a library's name or kind without regard to case", () => {
    expect(filterLibraries(items, "ANDROID").map(({ flowId }) => flowId)).toEqual(["f-android"]);
    expect(filterLibraries(items, "node lib").map(({ flowId }) => flowId)).toEqual(["f-review"]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterLibraries(items, "zzz")).toEqual([]);
  });
});
