import { describe, expect, it } from "vitest";
import { FlowCycleError, order } from "../../../src/core/flow/order.js";
import { parseFlow, type Flow } from "../../../src/core/flow/schema.js";

const at = { x: 0, y: 0 };
const withParent = (parent?: string) => (parent === undefined ? {} : { parent });

const prompt = (id: string, parent?: string) => ({
  id,
  label: id,
  position: at,
  type: "prompt",
  settings: { instructions: id },
  ...withParent(parent),
});

const loop = (id: string, parent?: string) => ({
  id,
  label: id,
  position: at,
  type: "loop",
  settings: { condition: "done", cap: 3, onCap: "fail" },
  ...withParent(parent),
});

const wire = (kind: string, from: string, to: string) => ({
  kind,
  from: { node: from, port: "out" },
  to: { node: to, port: "in" },
  ...(kind === "file" ? { file: "notes.md" } : {}),
});

const then = (from: string, to: string) => wire("then", from, to);

const flow = (nodes: unknown[], wires: unknown[]): Flow =>
  parseFlow({
    nodes,
    wires,
    session: {
      name: "main",
      workingFolder: { kind: "worktree", branch: "main" },
      model: "sonnet",
      allowedTools: [],
      permissionMode: "default",
      connectors: [],
    },
  });

function cycleError(input: Flow): FlowCycleError {
  try {
    order(input);
  } catch (error) {
    expect(error).toBeInstanceOf(FlowCycleError);
    return error as FlowCycleError;
  }
  expect.fail("order accepted a cycle");
}

describe("order", () => {
  it("puts a diamond's source first and sink last, whatever the array order", () => {
    const diamond = flow(
      [prompt("D"), prompt("B"), prompt("C"), prompt("A")],
      [then("A", "B"), then("A", "C"), then("B", "D"), then("C", "D")],
    );
    expect(order(diamond)).toEqual(["A", "B", "C", "D"]);
  });

  it.each([
    [
      ["P", "Q"],
      ["P", "Q"],
    ],
    [
      ["Q", "P"],
      ["Q", "P"],
    ],
  ])("breaks ties by array order: %j", (ids, expected) => {
    expect(
      order(
        flow(
          ids.map((id) => prompt(id)),
          [],
        ),
      ),
    ).toEqual(expected);
  });

  it("orders by Then wires only", () => {
    const input = flow(
      [prompt("B"), prompt("A")],
      [wire("file", "A", "B"), wire("event", "A", "B")],
    );
    expect(order(input)).toEqual(["B", "A"]);
  });

  it("rejects a cycle outside a loop, naming its nodes", () => {
    const error = cycleError(flow([prompt("A"), prompt("B")], [then("A", "B"), then("B", "A")]));
    expect(error.nodeIds).toEqual(["A", "B"]);
    expect(error.message).toContain("A");
    expect(error.message).toContain("B");
  });

  it("rejects a self-wire outside a loop", () => {
    expect(cycleError(flow([prompt("A")], [then("A", "A")])).nodeIds).toEqual(["A"]);
  });

  const loopNodes = [prompt("T"), loop("L"), prompt("X", "L"), prompt("Y", "L"), prompt("O")];

  it("orders a loop body with a back-wire to an entry wired from outside", () => {
    const input = flow(loopNodes, [then("T", "X"), then("X", "Y"), then("Y", "X"), then("Y", "O")]);
    expect(order(input)).toEqual(["T", "L", "X", "Y", "O"]);
  });

  it("orders a loop body with a back-wire to an entry wired from the loop", () => {
    const input = flow(loopNodes, [
      then("T", "L"),
      then("L", "X"),
      then("X", "Y"),
      then("Y", "X"),
      then("L", "O"),
    ]);
    expect(order(input)).toEqual(["T", "L", "X", "Y", "O"]);
  });

  it("rejects a cycle in a loop body that does not return to the entry", () => {
    const input = flow(
      [prompt("T"), loop("L"), prompt("X", "L"), prompt("Y", "L"), prompt("Z", "L")],
      [then("T", "X"), then("X", "Y"), then("Y", "Z"), then("Z", "Y")],
    );
    expect(cycleError(input).nodeIds).toEqual(["Y", "Z"]);
  });

  it("rejects a cycle in a loop body with no entry", () => {
    const input = flow(
      [loop("L"), prompt("X", "L"), prompt("Y", "L")],
      [then("X", "Y"), then("Y", "X")],
    );
    expect(cycleError(input).nodeIds).toEqual(["X", "Y"]);
  });

  it("rejects a cycle that crosses the loop boundary, naming the loop", () => {
    const input = flow(
      [prompt("A"), loop("L"), prompt("X", "L")],
      [then("A", "X"), then("X", "A")],
    );
    expect(cycleError(input).nodeIds).toEqual(["A", "L"]);
  });

  it("rejects a parent chain that revisits a node", () => {
    const input = flow([prompt("X", "Y"), prompt("Y", "X")], []);
    expect(cycleError(input).nodeIds).toEqual(["X", "Y"]);
  });

  it("orders a node whose parent is not in the flow at the top level", () => {
    const input = flow([prompt("A"), prompt("B", "ghost")], [then("A", "B")]);
    expect(order(input)).toEqual(["A", "B"]);
  });

  it("ignores a Then wire from a node that is not in the flow", () => {
    const input = flow(
      [loop("L"), prompt("X", "L"), prompt("Y", "L")],
      [then("ghost", "X"), then("X", "Y"), then("Y", "X")],
    );
    expect(cycleError(input).nodeIds).toEqual(["X", "Y"]);
  });
});
