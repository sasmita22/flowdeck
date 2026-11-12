import { describe, expect, it } from "vitest";
import { fileWiresToSettings } from "../../../src/core/flow/file-wires.js";
import { mainFlow } from "../../../src/core/flow/main-flow.js";
import {
  agent,
  fileWire,
  flow,
  forEach,
  output,
  thenWire,
  trigger,
} from "../../fixtures/flow-builders.js";

type RawNode = { id: string; settings: Record<string, unknown> };
type RawFlow = { nodes: RawNode[]; wires: unknown[] };

const session = { name: "main", model: "sonnet" };

const raw = (nodes: unknown[], wires: unknown[]) => ({ nodes, wires, session });

const converted = (input: unknown) => fileWiresToSettings(input) as RawFlow;

const settingsOf = (result: RawFlow, id: string) =>
  result.nodes.find((node) => node.id === id)?.settings;

const eventWire = (from: string, to: string) => ({
  kind: "event",
  from: { node: from, port: "out" },
  to: { node: to, port: "in" },
});

describe("fileWiresToSettings", () => {
  it("moves a File wire's file into the writer's writes and the reader's given", () => {
    const result = converted(
      raw([agent("plan"), agent("build")], [fileWire("plan", "build", "plan.md")]),
    );

    expect(settingsOf(result, "plan")?.writes).toEqual(["plan.md"]);
    expect(settingsOf(result, "build")?.given).toEqual(["plan.md"]);
    expect(result.wires).toEqual([]);
  });

  it("keeps declared files without duplicating them and leaves other wires alone", () => {
    const others = [thenWire("plan", "build"), eventWire("build", "plan")];
    const result = converted(
      raw(
        [
          agent("plan", { settings: { writes: ["plan.md"] } }),
          agent("build", { settings: { given: ["spec.md", "plan.md"] } }),
        ],
        [others[0], fileWire("plan", "build", "plan.md"), others[1]],
      ),
    );

    expect(settingsOf(result, "plan")?.writes).toEqual(["plan.md"]);
    expect(settingsOf(result, "build")?.given).toEqual(["spec.md", "plan.md"]);
    expect(result.wires).toEqual(others);
  });

  it("adds only to the writer's writes when the reader is a For each", () => {
    const list = forEach("units");
    const result = converted(raw([agent("plan"), list], [fileWire("plan", "units", "plan.md")]));

    expect(settingsOf(result, "plan")?.writes).toEqual(["plan.md"]);
    expect(settingsOf(result, "units")).toEqual(list.settings);
    expect(result.wires).toEqual([]);
  });

  it.each([
    ["a flow with no wires", { nodes: [agent("plan")], session }],
    ["a value that is not a flow", "not a flow"],
    ["null", null],
  ])("returns %s unchanged", (_, input) => {
    expect(fileWiresToSettings(input)).toEqual(input);
  });

  it("changes nothing when run again on its own result", () => {
    const once = fileWiresToSettings(
      raw(
        [agent("plan"), agent("build"), agent("review")],
        [fileWire("plan", "build", "plan.md"), fileWire("plan", "review", "plan.md")],
      ),
    );

    expect(fileWiresToSettings(once)).toEqual(once);
  });

  it("leaves a node reached only through a File wire off the main flow", () => {
    const result = converted(
      raw(
        [trigger("start"), agent("plan"), agent("build"), output("stop")],
        [thenWire("start", "plan"), thenWire("plan", "stop"), fileWire("plan", "build", "plan.md")],
      ),
    );

    expect(mainFlow(flow(result.nodes, result.wires))?.ignored.map((node) => node.id)).toEqual([
      "build",
    ]);
  });
});
