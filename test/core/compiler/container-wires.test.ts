import { describe, expect, it } from "vitest";
import { validate } from "../../../src/core/compiler/validate.js";
import {
  agent,
  bareFlow,
  flowSettings,
  output,
  sessionContainer,
  thenWire,
  trigger,
  wire,
  workspaceContainer,
} from "../../fixtures/flow-builders.js";
import { parseFlow } from "../../../src/core/flow/schema.js";

const library = (id: string) => ({
  id,
  label: id,
  position: { x: 0, y: 0 },
  type: "library",
  settings: { libraryId: "known-library", label: id, overrides: {} },
});

const intoWorkspace = wire("canvas-start", "out", "workspace-1", "flow-in");
const outOfWorkspace = wire("workspace-1", "flow-out", "canvas-stop", "in");

const workflow = (
  options: { nodes?: unknown[]; wires?: unknown[]; canvas?: unknown[]; path?: unknown[] } = {},
) =>
  parseFlow({
    nodes: [
      ...(options.canvas ?? [trigger("canvas-start"), output("canvas-stop")]),
      trigger("ws-start"),
      output("ws-stop"),
      trigger("s-start"),
      output("s-stop"),
      ...(options.nodes ?? []),
    ],
    wires: [
      ...(options.path ?? [intoWorkspace, outOfWorkspace]),
      thenWire("ws-start", "ws-stop"),
      thenWire("s-start", "s-stop"),
      ...(options.wires ?? []),
    ],
    settings: flowSettings,
    containers: [
      workspaceContainer(["ws-start", "ws-stop"]),
      sessionContainer(["s-start", "s-stop"]),
    ],
  });

const errorsOf = (ruleId: string, flow: ReturnType<typeof workflow>) =>
  validate(flow).filter((error) => error.rule === ruleId);

describe("container wire ends", () => {
  it("validates a workflow wired canvas Start → workspace → canvas Stop", () => {
    expect(validate(workflow())).toEqual([]);
  });

  describe("references", () => {
    it("accepts a wire to a container's flow-in", () => {
      expect(errorsOf("references", workflow())).toEqual([]);
    });

    it("still flags a wire to an unknown id", () => {
      const flow = workflow({ wires: [wire("canvas-start", "out", "nowhere", "flow-in")] });

      expect(errorsOf("references", flow).map((error) => error.wire)).toEqual([4]);
    });
  });

  describe("ports", () => {
    it.each([
      ["a port other than flow-in", [wire("canvas-start", "out", "workspace-1", "side")]],
      ["flow-in used as a from", [wire("workspace-1", "flow-in", "canvas-stop", "in")]],
      ["flow-out used as a to", [wire("canvas-start", "out", "workspace-1", "flow-out")]],
      [
        "an event wire",
        [{ ...wire("canvas-start", "out", "workspace-1", "flow-in"), kind: "event" }],
      ],
    ])("flags %s on a container", (_, wires) => {
      const errors = errorsOf("ports", workflow({ path: [...wires, outOfWorkspace] }));

      expect(errors.filter((error) => error.container === "workspace-1")).toEqual([
        expect.objectContaining({ wire: 0 }),
      ]);
    });
  });

  describe("node-ids", () => {
    it("flags a node whose id equals a container id", () => {
      const flow = workflow({ nodes: [agent("session-1")] });

      expect(errorsOf("node-ids", flow).map((error) => error.node)).toEqual(["session-1"]);
    });
  });

  describe("outside-container", () => {
    it("leaves the canvas Start, the canvas Stop and library nodes alone", () => {
      const flow = workflow({ nodes: [library("android-app")] });

      expect(errorsOf("outside-container", flow)).toEqual([]);
    });

    it("still flags any other canvas-level node", () => {
      const flow = workflow({
        nodes: [agent("stray")],
        path: [
          thenWire("canvas-start", "stray"),
          wire("stray", "out", "workspace-1", "flow-in"),
          outOfWorkspace,
        ],
      });

      expect(errorsOf("outside-container", flow).map((error) => error.node)).toEqual(["stray"]);
    });
  });

  describe("container-wires", () => {
    const onCanvas = (path: unknown[]) =>
      parseFlow({
        nodes: [trigger("canvas-start"), agent("a"), trigger("s-start"), output("canvas-stop")],
        wires: [...path, thenWire("s-start", "a")],
        settings: flowSettings,
        containers: [sessionContainer(["s-start", "a"])],
      });

    it("flags canvas wires straight into and out of a node inside a session", () => {
      const flow = onCanvas([thenWire("canvas-start", "a"), thenWire("a", "canvas-stop")]);

      expect(errorsOf("container-wires", flow).map((error) => error.wire)).toEqual([0, 1]);
    });

    it("flags a wire from a session's node into the workspace", () => {
      const flow = workflow({ wires: [thenWire("s-start", "ws-stop")] });

      expect(errorsOf("container-wires", flow).map((error) => error.wire)).toEqual([4]);
    });

    it("passes wires through a container's flow-in and flow-out", () => {
      const flow = onCanvas([
        wire("canvas-start", "out", "session-1", "flow-in"),
        wire("session-1", "flow-out", "canvas-stop", "in"),
      ]);

      expect(errorsOf("container-wires", flow)).toEqual([]);
    });
  });

  describe("workflow-path", () => {
    it.each([
      ["has no canvas Start", { canvas: [output("canvas-stop")], path: [outOfWorkspace] }],
      [
        "runs from Start to Stop past the workspace",
        { path: [thenWire("canvas-start", "canvas-stop")] },
      ],
      ["never reaches a canvas Stop", { path: [intoWorkspace] }],
      [
        "reaches its Stop only past the workspace",
        { path: [intoWorkspace, thenWire("canvas-start", "canvas-stop")] },
      ],
    ])("flags a workflow that %s", (_, options) => {
      expect(errorsOf("workflow-path", workflow(options))).toEqual([
        expect.objectContaining({
          message: "A workflow runs from its Start through the workspace to its Stop.",
        }),
      ]);
    });

    it("passes canvas Start → workspace → Stop", () => {
      expect(errorsOf("workflow-path", workflow())).toEqual([]);
    });

    it("never flags a blueprint without a workspace", () => {
      const flow = bareFlow([agent("a")]);

      expect(errorsOf("workflow-path", flow)).toEqual([]);
    });
  });
});
