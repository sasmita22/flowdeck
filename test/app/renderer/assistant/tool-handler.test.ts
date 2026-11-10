import { describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { FlowdeckBridge } from "../../../../src/app/preload/bridge.js";
import { createToolHandler } from "../../../../src/app/renderer/assistant/tool-handler.js";
import {
  createCanvasStore,
  nextNodeId,
  placeNode,
  selectDirty,
} from "../../../../src/app/renderer/canvas/store.js";
import type { NavState, Page } from "../../../../src/app/renderer/nav-store.js";
import { createSaveStore } from "../../../../src/app/renderer/save-store.js";
import { validate } from "../../../../src/core/compiler/validate.js";
import { checkEdit, newProblems } from "../../../../src/core/flow/blueprint-edits.js";
import type { Flow, Variable } from "../../../../src/core/flow/schema.js";
import { agent, flow, output, thenWire, trigger } from "../../../fixtures/flow-builders.js";

type HandlerBridge = Pick<
  FlowdeckBridge,
  | "saveFlow"
  | "openFlow"
  | "listFlows"
  | "renameFlow"
  | "setDirty"
  | "onCloseRequest"
  | "answerClose"
  | "onToolCall"
  | "onToolTurnEnd"
  | "answerToolCall"
>;

type Saved = { flowId: string; name: string; flow: Flow };

const summary = ({ flowId, name }: Saved) => ({
  flowId,
  name,
  createdAt: "2026-11-01T00:00:00.000Z",
  versions: 1,
  lastSavedAt: "2026-11-01T00:00:00.000Z",
  buildConfig: null,
  pinned: false,
});

const openBlueprint = (): Saved => ({
  flowId: "flow-1",
  name: "Plan",
  flow: flow(
    [trigger("start"), agent("p1"), agent("agent-1")],
    [thenWire("start", "p1"), thenWire("p1", "agent-1")],
  ),
});

const otherBlueprints = (): Saved[] => [
  { flowId: "flow-2", name: "Review", flow: flow([agent("lint-step")], []) },
  { flowId: "flow-3", name: "Lint rules", flow: flow([agent("p1")], []) },
  { flowId: "flow-4", name: "Deploy", flow: flow([agent("ship")], []) },
];

const fakeBridge = (blueprints: readonly Saved[]) => {
  const callListeners: ((call: unknown) => void)[] = [];
  const turnEndListeners: ((turnEnd: unknown) => void)[] = [];
  const waiting = new Map<string, (result: unknown) => void>();
  const byId = (flowId: string | undefined) =>
    blueprints.find((saved) => saved.flowId === (flowId ?? "flow-1"));

  const bridge = {
    saveFlow: vi.fn<(payload: unknown) => Promise<unknown>>(() =>
      Promise.resolve({ kind: "saved", flowId: "flow-1", version: 2 }),
    ),
    openFlow: vi.fn<(payload: { flowId?: string }) => Promise<unknown>>(({ flowId }) => {
      const saved = byId(flowId);
      return Promise.resolve(saved === undefined ? null : { ...saved, version: 1 });
    }),
    listFlows: vi.fn<() => Promise<unknown>>(() => Promise.resolve(blueprints.map(summary))),
    renameFlow: vi.fn<(payload: { flowId: string; name: string }) => Promise<unknown>>(
      async () => null,
    ),
    setDirty: vi.fn<(dirty: boolean) => void>(),
    onCloseRequest: vi.fn(() => () => {}),
    answerClose: vi.fn<(answer: "close" | "cancel") => void>(),
    onToolCall: vi.fn((listener: (call: unknown) => void) => {
      callListeners.push(listener);
      return () => {};
    }),
    onToolTurnEnd: vi.fn((listener: (turnEnd: unknown) => void) => {
      turnEndListeners.push(listener);
      return () => {};
    }),
    answerToolCall: vi.fn<(requestId: string, result: unknown) => void>((requestId, result) => {
      waiting.get(requestId)?.(result);
    }),
  } satisfies HandlerBridge;

  let requests = 0;
  const call = (
    name: string,
    input: unknown,
    session = "fd-bp-flow-1",
  ): Promise<Record<string, unknown>> => {
    requests += 1;
    const requestId = `request-${requests}`;
    const answered = new Promise<Record<string, unknown>>((resolve) => {
      waiting.set(requestId, (result) => resolve(result as Record<string, unknown>));
    });
    for (const listener of callListeners) {
      listener({ requestId, session, name, input });
    }
    return answered;
  };

  const endTurn = () => {
    for (const listener of turnEndListeners) listener(undefined);
  };

  return { bridge, call, endTurn };
};

const setup = async ({
  open = true,
  page = { name: "editor" },
}: { open?: boolean; page?: Page } = {}) => {
  const blueprints = [openBlueprint(), ...otherBlueprints()];
  const { bridge, call, endTurn } = fakeBridge(blueprints);
  const canvas = createCanvasStore({ ready: false });
  const save = createSaveStore({ bridge, canvas });
  if (open) await save.getState().open();
  const nav = createStore<Pick<NavState, "page">>()(() => ({ page }));
  createToolHandler({ bridge, canvas, save, nav });
  return { bridge, call, endTurn, canvas, save, blueprints, nav };
};

const offBlueprint =
  "Edits go only to the blueprint this agent was opened on, and only while it is open in the editor.";

const selfWire = {
  kind: "then",
  from: { node: "p1", port: "out" },
  to: { node: "p1", port: "in" },
};

describe("tool handler edits", () => {
  it("add_node places a node with the next free id and answers its id and problems", async () => {
    const { call, canvas } = await setup();
    const before = canvas.getState().flow;
    const input = { type: "agent", label: "Test", settings: { instructions: "Run npm test." } };
    const check = checkEdit(before, "add_node", input);
    if (!check.ok || check.edit.tool !== "add_node") return expect.fail("checkEdit refused");

    const result = await call("add_node", input);

    const after = canvas.getState().flow;
    const added = after.nodes.find((node) => !before.nodes.some(({ id }) => id === node.id));
    expect(added).toMatchObject({
      id: nextNodeId("agent", before),
      type: "agent",
      label: "Test",
      settings: check.edit.settings,
    });
    expect(added?.id).toBe("agent-2");
    if (added === undefined) return;
    expect(placeNode(before, "agent", added.position)).toEqual(added.position);
    expect(result).toEqual({ ok: true, nodeId: "agent-2", problems: newProblems(before, after) });
    expect(canvas.getState().undoStack).toHaveLength(1);
  });

  it("wire applies a wire connect would refuse, and answers the problem it adds", async () => {
    const { call, canvas } = await setup();
    const before = canvas.getState().flow;
    expect(canvas.getState().connect(selfWire.from, selfWire.to)).toBe(false);
    expect(canvas.getState().flow).toBe(before);

    const result = await call("wire", selfWire);

    const after = canvas.getState().flow;
    expect(after.wires).toEqual([...before.wires, selfWire]);
    const problems = newProblems(before, after);
    expect(problems).toEqual([expect.objectContaining({ rule: "no-cycle", node: "p1" })]);
    expect(result).toEqual({ ok: true, problems });
  });

  it("change_node applies", async () => {
    const { call, canvas } = await setup();

    const result = await call("change_node", { nodeId: "p1", label: "Planner" });

    expect(result).toMatchObject({ ok: true });
    expect(canvas.getState().flow.nodes.find(({ id }) => id === "p1")?.label).toBe("Planner");
    expect(canvas.getState().undoStack).toHaveLength(1);
  });

  it("delete_node applies, taking the node's wires with it", async () => {
    const { call, canvas } = await setup();

    const result = await call("delete_node", { nodeId: "p1" });

    expect(result).toMatchObject({ ok: true });
    const after = canvas.getState().flow;
    expect(after.nodes.map(({ id }) => id)).toEqual(["start", "agent-1"]);
    expect(after.wires).toEqual([]);
    expect(canvas.getState().undoStack).toHaveLength(1);
  });

  it("set_variable applies through the variable command", async () => {
    const { call, canvas } = await setup();
    const variable: Variable = { kind: "text", name: "ticket", default: "FD-1" };
    const expected = canvas.getState().variableCommand(variable).do(canvas.getState().flow);

    const result = await call("set_variable", variable);

    expect(result).toMatchObject({ ok: true });
    expect(canvas.getState().flow).toEqual(expected);
    expect(canvas.getState().flow.session.buildConfig.variables).toEqual([variable]);
    expect(canvas.getState().undoStack).toHaveLength(1);
  });

  it("refuses a schema-failing edit, leaving the flow and the undo stack alone", async () => {
    const { call, canvas } = await setup();
    const before = canvas.getState().flow;

    const result = await call("change_node", { nodeId: 7 });

    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/\S/) });
    expect(canvas.getState().flow).toBe(before);
    expect(canvas.getState().undoStack).toEqual([]);
  });

  it("applies an edit from the open blueprint's session", async () => {
    const { call, canvas, save } = await setup();

    const applied = await call("change_node", { nodeId: "p1", label: "Planner" }, "fd-bp-flow-1");

    expect(applied).toMatchObject({ ok: true });
    expect(canvas.getState().flow.nodes.find(({ id }) => id === "p1")?.label).toBe("Planner");
    expect(save.getState().flowId).toBe("flow-1");
  });

  it("closes the undo group at a turn end", async () => {
    const { call, endTurn, canvas } = await setup();

    await call("add_node", { type: "agent", label: "One" });
    await call("add_node", { type: "agent", label: "Two" });
    endTurn();
    await call("add_node", { type: "agent", label: "Three" });

    expect(canvas.getState().flow.nodes.map(({ label }) => label)).toEqual([
      "start",
      "p1",
      "agent-1",
      "One",
      "Two",
      "Three",
    ]);
    expect(canvas.getState().undoStack).toHaveLength(2);
  });

  it("never saves, so agent edits stay unsaved", async () => {
    const { bridge, call, canvas } = await setup();

    await call("add_node", { type: "agent", label: "One" });
    await call("wire", selfWire);
    await call("change_node", { nodeId: "p1", label: "Planner" });
    await call("set_variable", { kind: "yesno", name: "dry" });
    await call("delete_node", { nodeId: "agent-1" });
    await call("read_blueprint", {});

    expect(bridge.saveFlow).not.toHaveBeenCalled();
    expect(selectDirty(canvas.getState())).toBe(true);
  });
});

describe("tool handler reads", () => {
  it("read_blueprint returns the open flow, clean, with its problems", async () => {
    const { call, canvas } = await setup();

    const result = await call("read_blueprint", {});

    const current = canvas.getState().flow;
    expect(result).toMatchObject({
      ok: true,
      flow: current,
      unsaved: false,
      problems: validate(current),
    });
  });

  it("read_blueprint returns unsaved edits, marked unsaved, with every current problem", async () => {
    const { call, canvas } = await setup();
    await call("wire", selfWire);
    await call("change_node", { nodeId: "p1", label: "Planner" });

    const result = await call("read_blueprint", {});

    const current = canvas.getState().flow;
    expect(current.nodes.find(({ id }) => id === "p1")?.label).toBe("Planner");
    expect(validate(current)).not.toEqual([]);
    expect(result).toMatchObject({
      ok: true,
      flow: current,
      unsaved: true,
      problems: validate(current),
    });
  });

  it("read_blueprint of another flow id reads it through the bridge and opens nothing", async () => {
    const { bridge, call, canvas, save, blueprints } = await setup();
    const before = canvas.getState().flow;
    const review = blueprints.find(({ flowId }) => flowId === "flow-2");

    const result = await call("read_blueprint", { blueprint: "flow-2" });

    expect(bridge.openFlow).toHaveBeenLastCalledWith({ flowId: "flow-2" });
    expect(result).toMatchObject({ ok: true, flow: review?.flow });
    expect(canvas.getState().flow).toBe(before);
    expect(save.getState().flowId).toBe("flow-1");
  });

  it("read_blueprint raises no problem for a blank Agent added off the main flow", async () => {
    const { call } = await setup();
    const added = await call("add_node", {
      type: "agent",
      label: "Blank",
      settings: { instructions: "" },
    });

    const result = await call("read_blueprint", {});

    expect(result.problems).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ node: added.nodeId })]),
    );
  });

  describe("read_blueprint of another flow id reads its main flow", () => {
    const blankAgent = agent("blank", { settings: { instructions: "" } });
    const readSaved = async (saved: Flow) => {
      const { call, blueprints } = await setup();
      blueprints.push({ flowId: "flow-5", name: "Loose", flow: saved });
      return call("read_blueprint", { blueprint: "flow-5" });
    };

    it("raising no problem for a blank Agent off it", async () => {
      const result = await readSaved(
        flow(
          [trigger("start"), agent("a"), output("stop"), blankAgent],
          [thenWire("start", "a"), thenWire("a", "stop")],
        ),
      );

      expect(result.problems).toEqual([]);
    });

    it("raising one-start when it has no Start", async () => {
      const result = await readSaved(
        flow([agent("a"), output("stop"), blankAgent], [thenWire("a", "stop")]),
      );

      expect(result.problems).toEqual(
        expect.arrayContaining([expect.objectContaining({ rule: "one-start" })]),
      );
    });
  });

  it("list_blueprints returns every summary from listFlows", async () => {
    const { call, blueprints } = await setup();

    const result = await call("list_blueprints", {});

    expect(result).toEqual({ ok: true, blueprints: blueprints.map(summary) });
  });

  it("search_blueprints returns the blueprints whose name or node label matches", async () => {
    const { call } = await setup();

    const result = await call("search_blueprints", { query: "LINT" });

    expect(result).toMatchObject({ ok: true });
    const found = result["blueprints"] as { flowId: string }[];
    expect(found.map(({ flowId }) => flowId).sort()).toEqual(["flow-2", "flow-3"]);
  });
});

describe("tool handler edits off the blueprint, refused", () => {
  const unchanged = (canvas: Awaited<ReturnType<typeof setup>>["canvas"]) => {
    const { flow, undoStack } = canvas.getState();
    const dirty = selectDirty(canvas.getState());
    return () => {
      expect(canvas.getState().flow).toBe(flow);
      expect(canvas.getState().undoStack).toEqual(undoStack);
      expect(selectDirty(canvas.getState())).toBe(dirty);
    };
  };

  it("refuses an edit from fd-bp-flow-1 while the canvas holds another blueprint", async () => {
    const { call, canvas, save } = await setup();
    await save.getState().open("flow-2");
    const expectUnchanged = unchanged(canvas);

    const result = await call("add_node", { type: "agent", label: "Tests" }, "fd-bp-flow-1");

    expect(result).toEqual({ ok: false, reason: offBlueprint });
    expectUnchanged();
    expect(save.getState().flowId).toBe("flow-2");
  });

  it("refuses an edit while no saved blueprint is open", async () => {
    const { call, canvas, save } = await setup();
    save.getState().startNew();
    expect(save.getState().flowId).toBeNull();
    const expectUnchanged = unchanged(canvas);

    const result = await call("add_node", { type: "agent", label: "Tests" }, "fd-bp-flow-1");

    expect(result).toEqual({ ok: false, reason: offBlueprint });
    expectUnchanged();
  });

  it("refuses an edit while the page is not the editor", async () => {
    const { call, canvas } = await setup({ page: { name: "blueprints" } });
    const expectUnchanged = unchanged(canvas);

    const result = await call("add_node", { type: "agent", label: "Tests" }, "fd-bp-flow-1");

    expect(result).toEqual({ ok: false, reason: offBlueprint });
    expectUnchanged();
  });

  it("refuses an edit naming another blueprint and opens nothing", async () => {
    const { bridge, call, canvas, save } = await setup();
    const opens = bridge.openFlow.mock.calls.length;
    const expectUnchanged = unchanged(canvas);

    const result = await call(
      "add_node",
      { type: "agent", label: "Tests", blueprint: "flow-2" },
      "fd-bp-flow-1",
    );

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("blueprint") });
    expectUnchanged();
    expect(save.getState().flowId).toBe("flow-1");
    expect(bridge.openFlow).toHaveBeenCalledTimes(opens);
  });
});

describe("tool handler reads never open", () => {
  it.each([
    ["read_blueprint", { blueprint: "flow-2" }],
    ["list_blueprints", {}],
    ["search_blueprints", { query: "lint" }],
  ])("%s never opens a blueprint", async (name, input) => {
    const { call, canvas, save } = await setup();
    const before = canvas.getState().flow;

    const result = await call(name, input);

    expect(result).toMatchObject({ ok: true });
    expect(save.getState().flowId).toBe("flow-1");
    expect(canvas.getState().flow).toBe(before);
  });
});

describe("tool handler before the canvas is ready", () => {
  it.each([
    ["add_node", { type: "agent", label: "One" }],
    ["read_blueprint", {}],
  ])("answers %s with the canvas not ready", async (name, input) => {
    const { call, canvas } = await setup({ open: false });
    const before = canvas.getState().flow;

    const result = await call(name, input);

    expect(result).toEqual({ ok: false, reason: "the canvas is not ready" });
    expect(canvas.getState().flow).toBe(before);
    expect(canvas.getState().undoStack).toEqual([]);
  });
});
