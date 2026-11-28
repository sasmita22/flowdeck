import { describe, expect, it } from "vitest";
import { flowsEqual } from "../../../src/core/flow/equal.js";
import { parseFlow, type Flow, type FlowContainer } from "../../../src/core/flow/schema.js";
import { agent, flow, flowSettings, thenWire } from "../../fixtures/flow-builders.js";

const nth = <T>(list: T[], index: number): T => {
  const item = list[index];
  if (item === undefined) throw new Error(`no item at ${index}`);
  return item;
};

const base = (settings: Record<string, unknown> = flowSettings): Flow =>
  flow(
    [
      agent("p1"),
      agent("a1", {
        parent: "p1",
        settings: {
          produces: [{ variable: "approved", yesIf: "it reads well", noIf: "it does not" }],
        },
      }),
      agent("s1", { settings: { tools: ["Bash"] } }),
    ],
    [thenWire("p1", "a1"), thenWire("a1", "s1")],
    settings,
  );

const agentSettings = (extra: { instructions?: string; tools?: string[] }) => ({
  role: "implementer",
  instructions: "Implement the plan.",
  model: "sonnet",
  tools: [],
  ...extra,
});

const reverseKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, inner]) => [key, reverseKeys(inner)]),
    );
  }
  return value;
};

const containerOf = <Kind extends FlowContainer["kind"]>(
  flow: Flow,
  kind: Kind,
): Extract<FlowContainer, { kind: Kind }> => {
  const found = flow.containers.find(
    (container): container is Extract<FlowContainer, { kind: Kind }> => container.kind === kind,
  );
  if (found === undefined) throw new Error(`no ${kind} container`);
  return found;
};

const edited = (edit: (flow: Flow) => void): Flow => {
  const copy = structuredClone(base());
  edit(copy);
  return copy;
};

describe("flowsEqual", () => {
  it("treats a flow as equal to a copy of itself", () => {
    expect(flowsEqual(base(), base())).toBe(true);
  });

  it("ignores the order of object keys", () => {
    const reordered = reverseKeys(base()) as Flow;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(base()));

    expect(flowsEqual(base(), reordered)).toBe(true);
    expect(flowsEqual(reordered, base())).toBe(true);
  });

  it.each<[string, (flow: Flow) => void]>([
    ["a node position", (f) => (nth(f.nodes, 0).position = { x: 10, y: 0 })],
    ["a node label", (f) => (nth(f.nodes, 0).label = "renamed")],
    ["a node parent", (f) => (nth(f.nodes, 1).parent = "s1")],
    [
      "a setting value",
      (f) => (nth(f.nodes, 0).settings = agentSettings({ instructions: "Other work." })),
    ],
    [
      "a list setting value",
      (f) => (nth(f.nodes, 2).settings = agentSettings({ tools: ["Read"] })),
    ],
    ["a wire end", (f) => (nth(f.wires, 0).to = { node: "s1", port: "in" })],
    ["a removed wire", (f) => f.wires.pop()],
    ["a session model", (f) => (containerOf(f, "session").model = "haiku")],
    ["a session repo", (f) => (containerOf(f, "session").repo = "/x")],
    ["a session branch", (f) => (containerOf(f, "session").branch = "dev")],
    ["a session name", (f) => (containerOf(f, "session").name = "review")],
    ["a workspace model", (f) => (containerOf(f, "workspace").model = "opus")],
    ["a removed container", (f) => f.containers.pop()],
  ])("tells flows apart by %s", (_, edit) => {
    const other = edited(edit);

    expect(flowsEqual(base(), other)).toBe(false);
    expect(flowsEqual(other, base())).toBe(false);
  });

  it("tells flows apart by their permission mode", () => {
    const planOnly = base({ ...flowSettings, permissionMode: "plan" });

    expect(flowsEqual(base(), planOnly)).toBe(false);
    expect(flowsEqual(planOnly, base())).toBe(false);
  });

  it("treats flows with the same settings as equal", () => {
    const settings = { buildModel: "opus", permissionMode: "plan" };

    expect(flowsEqual(base(settings), base({ ...settings }))).toBe(true);
  });

  it("tells flows apart by the members of their containers", () => {
    const framed = edited((f) => (containerOf(f, "session").nodes = ["p1", "s1"]));
    const fewer = edited((f) => (containerOf(f, "session").nodes = ["p1"]));

    expect(flowsEqual(framed, fewer)).toBe(false);
    expect(flowsEqual(fewer, framed)).toBe(false);
  });

  it("tells flows apart by node order", () => {
    const other = edited((f) => f.nodes.reverse());

    expect(flowsEqual(base(), other)).toBe(false);
  });

  it("tells flows apart by wire order", () => {
    const other = edited((f) => f.wires.reverse());

    expect(flowsEqual(base(), other)).toBe(false);
  });

  it("tells an absent optional key from a present one", () => {
    const withoutParent = edited((f) => delete nth(f.nodes, 1).parent);
    const withProduces = edited((f) => Object.assign(nth(f.nodes, 0).settings, { produces: [] }));

    expect(flowsEqual(base(), withoutParent)).toBe(false);
    expect(flowsEqual(withoutParent, base())).toBe(false);
    expect(flowsEqual(base(), withProduces)).toBe(false);
    expect(flowsEqual(withProduces, base())).toBe(false);
  });

  it("tells flows apart by their connections", () => {
    const connected = edited((f) => (f.connections = [{ id: "c1", between: ["s-a", "s-b"] }]));
    const reconnected = edited((f) => (f.connections = [{ id: "c1", between: ["s-a", "s-c"] }]));

    expect(flowsEqual(base(), connected)).toBe(false);
    expect(flowsEqual(connected, base())).toBe(false);
    expect(flowsEqual(connected, reconnected)).toBe(false);
  });

  it("treats a flow without connections as equal to its parsed copy", () => {
    const reloaded = parseFlow(JSON.parse(JSON.stringify(base())));

    expect(reloaded).not.toHaveProperty("connections");
    expect(flowsEqual(base(), reloaded)).toBe(true);
  });
});
