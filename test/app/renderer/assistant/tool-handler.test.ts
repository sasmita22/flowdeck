import { describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type { FlowdeckBridge } from "../../../../src/app/preload/bridge.js";
import { createToolHandler } from "../../../../src/app/renderer/assistant/tool-handler.js";
import { labelIn } from "../../../../src/core/flow/library-checks.js";
import { flowSummary } from "../../../fixtures/flow-summary.js";
import { moveNodes } from "../../../../src/app/renderer/canvas/commands.js";
import { tidyMoves } from "../../../../src/app/renderer/canvas/layout.js";
import {
  createCanvasStore,
  nextNodeId,
  placeNode,
  selectDirty,
} from "../../../../src/app/renderer/canvas/store.js";
import type { NavState, Page } from "../../../../src/app/renderer/nav-store.js";
import { createSaveStore } from "../../../../src/app/renderer/save-store.js";
import { reasonNaming } from "../../../../src/core/compiler/problems.js";
import { rule as libraryUse } from "../../../../src/core/compiler/rules/library-use.js";
import { validate } from "../../../../src/core/compiler/validate.js";
import { checkEdit, editProblems, newProblems } from "../../../../src/core/flow/blueprint-edits.js";
import {
  libraryLabelFor,
  loopReason,
  type BlueprintKind,
  type LibraryLookup,
} from "../../../../src/core/flow/libraries.js";
import type { Flow, Node } from "../../../../src/core/flow/schema.js";
import {
  agent,
  flow,
  flowSettings,
  output,
  sessionContainer,
  thenWire,
  trigger,
  workspaceContainer,
} from "../../../fixtures/flow-builders.js";
import { boundsOf, flowContainerBounds } from "../../../../src/app/renderer/canvas/frames.js";

vi.mock("../../../../src/app/renderer/canvas/layout.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/app/renderer/canvas/layout.js")>();
  return { ...actual, tidyMoves: vi.fn(actual.tidyMoves) };
});

type HandlerBridge = Pick<
  FlowdeckBridge,
  | "saveFlow"
  | "openFlow"
  | "listFlows"
  | "renameFlow"
  | "setDirty"
  | "onCloseRequest"
  | "answerClose"
  | "onRunQuitRequest"
  | "answerRunQuit"
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
  variables: [],
  pinned: false,
  kind: "workflow",
  sessions: [],
  uses: [],
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
    onRunQuitRequest: vi.fn(() => () => {}),
    answerRunQuit: vi.fn<(answer: "keep" | "stop" | "cancel") => void>(),
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
    expect(result).toEqual({
      ok: true,
      nodeId: "agent-2",
      problems: editProblems(before, after, ["agent-2"]),
    });
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
    expect(after.nodes.map(({ id }) => id)).toEqual([
      "start",
      "agent-1",
      "workspace-1-start",
      "workspace-1-stop",
      "canvas-start",
      "canvas-stop",
    ]);
    expect(after.wires.map(({ from, to }) => `${from.node}>${to.node}`)).toEqual([
      "workspace-1-start>workspace-1-stop",
      "canvas-start>workspace-1",
      "workspace-1>canvas-stop",
    ]);
    expect(canvas.getState().undoStack).toHaveLength(1);
  });

  it("refuses set_variable, since variables are found, not declared", async () => {
    const { call, canvas } = await setup();
    const before = canvas.getState().flow;

    const result = await call("set_variable", { kind: "text", name: "ticket" });

    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/\S/) });
    expect(canvas.getState().flow).toBe(before);
    expect(canvas.getState().undoStack).toEqual([]);
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
      "workspace-1-start",
      "workspace-1-stop",
      "canvas-start",
      "canvas-stop",
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

  it("read_blueprint of a deleted blueprint answers that it was deleted", async () => {
    const { bridge, call } = await setup();
    bridge.openFlow.mockRejectedValueOnce(new Error("Blueprint flow-9 was deleted"));

    const result = await call("read_blueprint", { blueprint: "flow-9" });

    expect(result).toEqual({ ok: false, reason: "Blueprint flow-9 was deleted" });
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

describe("tool handler and session containers", () => {
  const containerIn = (current: Flow, id: string) =>
    current.containers.find((container) => container.id === id);

  it("read_blueprint answers each session container by id, with its name, repo, branch and model", async () => {
    const { call, canvas } = await setup();

    const result = await call("read_blueprint", {});

    expect((result["flow"] as Flow).containers).toEqual(canvas.getState().flow.containers);
    expect(containerIn(result["flow"] as Flow, "session-1")).toEqual({
      id: "session-1",
      kind: "session",
      name: "main",
      repo: "/work/repo",
      branch: "main",
      model: "sonnet",
      nodes: ["start", "p1", "agent-1"],
    });
  });

  it("delete_node takes the node off its session container's members only", async () => {
    const { call, canvas } = await setup();
    const workspace = containerIn(canvas.getState().flow, "workspace-1");

    await call("delete_node", { nodeId: "p1" });

    const after = canvas.getState().flow;
    expect(containerIn(after, "session-1")?.nodes).toEqual(["start", "agent-1"]);
    expect(containerIn(after, "workspace-1")).toEqual(workspace);
  });

  it("add_node with a container as its parent adds the node to that container, with no parent", async () => {
    const { call, canvas } = await setup();
    const before = canvas.getState().flow;

    const result = await call("add_node", { type: "agent", label: "Four", parent: "session-1" });

    expect(result).toMatchObject({ ok: true, nodeId: "agent-2" });
    const after = canvas.getState().flow;
    expect(containerIn(after, "session-1")?.nodes).toEqual(["start", "p1", "agent-1", "agent-2"]);
    expect(after.nodes.find(({ id }) => id === "agent-2")).not.toHaveProperty("parent");

    canvas.getState().undo();
    expect(canvas.getState().flow).toEqual(before);
  });

  it("add_node into a container places the node beside that container's members, clear of every other frame", async () => {
    const { call, canvas } = await setup();
    const at = <N extends object>(node: N, x: number, y: number) => ({
      ...node,
      position: { x, y },
    });
    canvas.getState().load(
      flow(
        [
          at(trigger("w-start"), 0, 60),
          at(output("w-stop"), 300, 60),
          at(trigger("start"), 0, 400),
          at(agent("p1"), 200, 400),
          at(output("stop"), 500, 400),
        ],
        [thenWire("w-start", "w-stop"), thenWire("start", "p1"), thenWire("p1", "stop")],
        flowSettings,
        {
          containers: [
            workspaceContainer(["w-start", "w-stop"]),
            sessionContainer(["start", "p1", "stop"]),
          ],
        },
      ),
    );

    await call("add_node", { type: "agent", label: "Four", parent: "session-1" });

    const after = canvas.getState().flow;
    const added = after.nodes.find(({ id }) => id === "agent-1");
    if (added === undefined) return expect.fail("agent-1 was not added");
    const bounds = boundsOf(added);
    const workspace = flowContainerBounds(after, "workspace-1");
    expect(
      bounds.left < workspace.right &&
        workspace.left < bounds.right &&
        bounds.top < workspace.bottom &&
        workspace.top < bounds.bottom,
    ).toBe(false);
    expect(added.position.y).toBe(400);
  });

  it("delete_node of a container's last member removes the container, in the ask's one undo step", async () => {
    const { call, canvas } = await setup();
    const before = canvas.getState().flow;

    await call("delete_node", { nodeId: "workspace-1-start" });
    await call("delete_node", { nodeId: "workspace-1-stop" });

    expect(canvas.getState().flow.containers.map(({ id }) => id)).toEqual(["session-1"]);
    expect(canvas.getState().undoStack).toHaveLength(1);

    canvas.getState().undo();
    expect(canvas.getState().flow).toEqual(before);
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

describe("tool handler tidy", () => {
  const defaultSize = { width: 1600, height: 1000 };

  const tidied = async (from: Flow) => moveNodes(await tidyMoves(from, defaultSize)).do(from);

  type Canvas = Awaited<ReturnType<typeof setup>>["canvas"];

  const settled = async (canvas: Canvas) => {
    await tidyMoves(canvas.getState().flow, defaultSize);
    await new Promise((resolve) => setTimeout(resolve, 50));
  };

  const tidiedTo = (canvas: Canvas, expected: Flow) =>
    vi.waitFor(() => expect(canvas.getState().flow).toEqual(expected), { timeout: 2_000 });

  it("tidy_layout lays the blueprint out as tidyMoves does, inside the ask's one undo step", async () => {
    const { call, endTurn, canvas } = await setup();
    const before = canvas.getState().flow;
    await call("add_node", { type: "agent", label: "One" });
    await call("add_node", { type: "agent", label: "Two" });
    const added = canvas.getState().flow;
    const expected = await tidied(added);
    expect(expected).not.toEqual(added);

    const result = await call("tidy_layout", {});

    expect(result).toEqual({ ok: true, problems: [] });
    expect(canvas.getState().flow).toEqual(expected);
    expect(canvas.getState().fitSeq).toBe(1);
    endTurn();
    await settled(canvas);
    expect(canvas.getState().undoStack).toHaveLength(1);
    canvas.getState().undo();
    expect(canvas.getState().flow).toEqual(before);
  });

  it("runs no second layout at the turn end of an ask whose last edit is tidy_layout", async () => {
    const { call, endTurn, canvas } = await setup();
    await call("add_node", { type: "agent", label: "One" });
    await call("tidy_layout", {});
    const laidOut = canvas.getState().flow;
    expect(laidOut).toEqual(await tidied(laidOut));
    expect(canvas.getState().fitSeq).toBe(1);

    endTurn();
    await settled(canvas);

    expect(canvas.getState().flow).toBe(laidOut);
    expect(canvas.getState().fitSeq).toBe(1);
  });

  it("lays out once for an ask whose last edit is tidy_layout, on the tool call and not at the turn end", async () => {
    const { call, endTurn } = await setup();
    await call("add_node", { type: "agent", label: "One" });
    vi.mocked(tidyMoves).mockClear();

    await call("tidy_layout", {});
    endTurn();

    expect(tidyMoves).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["one node", ["One"]],
    ["three nodes", ["One", "Two", "Three"]],
  ])(
    "lays out once, at the turn end, for an ask that adds %s without tidy_layout",
    async (_, labels) => {
      const { call, endTurn, canvas } = await setup();
      const layouts = vi.mocked(tidyMoves);
      layouts.mockClear();
      for (const label of labels) await call("add_node", { type: "agent", label });
      expect(layouts).not.toHaveBeenCalled();
      const expected = await tidied(canvas.getState().flow);
      layouts.mockClear();

      endTurn();
      await tidiedTo(canvas, expected);

      expect(layouts).toHaveBeenCalledTimes(1);
    },
  );

  it("tidy_layout on a tidy blueprint answers ok and adds no undo step", async () => {
    const { call, canvas } = await setup();
    await canvas.getState().tidy();
    const laidOut = canvas.getState().flow;
    const { undoStack, fitSeq } = canvas.getState();

    const result = await call("tidy_layout", {});

    expect(result).toEqual({ ok: true, problems: [] });
    expect(canvas.getState().flow).toBe(laidOut);
    expect(canvas.getState().undoStack).toEqual(undoStack);
    expect(canvas.getState().fitSeq).toBe(fitSeq);
  });

  it("tidies an ask that added nodes without tidy_layout at its turn end, inside its undo step", async () => {
    const { call, endTurn, canvas } = await setup();
    const before = canvas.getState().flow;
    await call("add_node", { type: "agent", label: "One" });
    await call("add_node", { type: "agent", label: "Two" });
    await call("add_node", { type: "agent", label: "Three" });
    const expected = await tidied(canvas.getState().flow);
    expect(expected).not.toEqual(canvas.getState().flow);

    endTurn();

    await tidiedTo(canvas, expected);
    expect(canvas.getState().undoStack).toHaveLength(1);
    expect(canvas.getState().fitSeq).toBe(1);
    canvas.getState().undo();
    expect(canvas.getState().flow).toEqual(before);
  });

  it("tidies at the turn end when a node is added after tidy_layout", async () => {
    const { call, endTurn, canvas } = await setup();
    const before = canvas.getState().flow;
    await call("add_node", { type: "agent", label: "One" });
    await call("tidy_layout", {});
    await call("add_node", { type: "agent", label: "Two" });
    const expected = await tidied(canvas.getState().flow);
    expect(expected).not.toEqual(canvas.getState().flow);

    endTurn();

    await tidiedTo(canvas, expected);
    expect(canvas.getState().undoStack).toHaveLength(1);
    canvas.getState().undo();
    expect(canvas.getState().flow).toEqual(before);
  });

  it("moves nothing at the turn end of an ask that added no nodes or wires", async () => {
    const { call, endTurn, canvas } = await setup();
    await call("change_node", { nodeId: "p1", label: "Planner" });
    const edited = canvas.getState().flow;
    expect(await tidied(edited)).not.toEqual(edited);

    endTurn();
    await settled(canvas);

    expect(canvas.getState().flow).toBe(edited);
    expect(canvas.getState().fitSeq).toBe(0);
  });

  it("tidies each of two asks in a row once", async () => {
    const { call, endTurn, canvas } = await setup();
    await call("add_node", { type: "agent", label: "One" });
    const first = await tidied(canvas.getState().flow);
    endTurn();
    await tidiedTo(canvas, first);
    await call("add_node", { type: "agent", label: "Two" });
    const second = await tidied(canvas.getState().flow);
    expect(second).not.toEqual(canvas.getState().flow);

    endTurn();

    await tidiedTo(canvas, second);
    await settled(canvas);
    expect(canvas.getState().undoStack).toHaveLength(2);
    expect(canvas.getState().fitSeq).toBe(2);
    canvas.getState().undo();
    expect(canvas.getState().flow).toEqual(first);
  });

  it.each<[string, (context: Awaited<ReturnType<typeof setup>>) => Promise<unknown>]>([
    [
      "the next ask edits right after the turn end",
      ({ call }) => call("change_node", { nodeId: "p1", label: "Planner" }),
    ],
    ["undo runs", async ({ canvas }) => canvas.getState().undo()],
    [
      "the editor is no longer shown",
      async ({ nav }) => nav.setState({ page: { name: "blueprints" } }),
    ],
  ])("drops the turn-end tidy when %s before it resolves", async (_, act) => {
    const context = await setup();
    const { call, endTurn, canvas } = context;
    await call("add_node", { type: "agent", label: "One" });
    const added = canvas.getState().flow;
    expect(await tidied(added)).not.toEqual(added);

    endTurn();
    await act(context);
    const acted = canvas.getState().flow;
    await settled(canvas);

    expect(canvas.getState().flow).toBe(acted);
    expect(canvas.getState().fitSeq).toBe(0);
  });

  const deferredLayout = () => {
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(tidyMoves).mockImplementationOnce(async (...args) => {
      const actual = await vi.importActual<
        typeof import("../../../../src/app/renderer/canvas/layout.js")
      >("../../../../src/app/renderer/canvas/layout.js");
      const moves = await actual.tidyMoves(...args);
      await released;
      return moves;
    });
    return release;
  };

  it("refuses tidy_layout and moves nothing when the blueprint changes while it lays out", async () => {
    const { call, canvas } = await setup();
    await call("add_node", { type: "agent", label: "One" });
    const release = deferredLayout();

    const answer = call("tidy_layout", {});
    await call("change_node", { nodeId: "p1", label: "Planner" });
    const { flow, undoStack, fitSeq } = canvas.getState();
    release();

    expect(await answer).toEqual({
      ok: false,
      reason:
        "The blueprint changed while it was being laid out; nothing moved. Call tidy_layout again.",
    });
    expect(canvas.getState().flow).toBe(flow);
    expect(canvas.getState().undoStack).toEqual(undoStack);
    expect(canvas.getState().fitSeq).toBe(fitSeq);
  });

  it("refuses tidy_layout and moves nothing when the editor opens another blueprint while it lays out", async () => {
    const { call, canvas, save } = await setup();
    await call("add_node", { type: "agent", label: "One" });
    const release = deferredLayout();

    const answer = call("tidy_layout", {});
    await vi.waitFor(() => expect(tidyMoves).toHaveBeenCalled());
    await save.getState().open("flow-2");
    const { flow, undoStack, fitSeq } = canvas.getState();
    release();

    expect(await answer).toEqual({ ok: false, reason: offBlueprint });
    expect(canvas.getState().flow).toBe(flow);
    expect(canvas.getState().undoStack).toEqual(undoStack);
    expect(canvas.getState().fitSeq).toBe(fitSeq);
  });

  it("shows on the canvas when the turn-end tidy fails", async () => {
    const { call, endTurn, canvas } = await setup();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await call("add_node", { type: "agent", label: "One" });
    const added = canvas.getState().flow;
    vi.mocked(tidyMoves).mockRejectedValueOnce(new Error("layout engine crashed"));

    endTurn();

    await vi.waitFor(() =>
      expect(canvas.getState().message).toBe("Can't tidy the layout: layout engine crashed"),
    );
    expect(logged).toHaveBeenCalled();
    expect(canvas.getState().flow).toBe(added);
    logged.mockRestore();
  });

  it("keeps the next ask's edit intact when it lands right after a turn end", async () => {
    const { call, endTurn, canvas } = await setup();
    await call("add_node", { type: "agent", label: "One" });
    const added = canvas.getState().flow;

    endTurn();
    await call("change_node", { nodeId: "p1", label: "Planner" });
    await settled(canvas);

    const after = canvas.getState().flow;
    expect(after.nodes.find(({ id }) => id === "p1")?.label).toBe("Planner");
    expect(after.nodes.map(({ position }) => position)).toEqual(
      added.nodes.map(({ position }) => position),
    );
    expect(canvas.getState().undoStack).toHaveLength(2);
  });
});

describe("tool handler and library nodes", () => {
  const review = {
    flowId: "f-review",
    name: "Review",
    createdAt: "2026-01-01T00:00:00.000Z",
    versions: 1,
    lastSavedAt: "2026-01-01T00:00:00.000Z",
    buildConfig: null,
    variables: [],
    pinned: false,
    kind: "node-library" as const,
    sessions: [],
    uses: [],
  };

  const use = {
    id: "use",
    type: "library",
    label: "review",
    position: { x: 200, y: 0 },
    settings: { libraryId: "f-review", label: "review", overrides: {} },
  };

  const missing = /no longer exists/;

  const messagesOf = (result: Record<string, unknown>) =>
    (result["problems"] as { message: string }[]).map(({ message }) => message);

  it("read_blueprint does not report a known library as missing", async () => {
    const { call, canvas } = await setup();
    canvas.getState().setLibraries([review], "flow-1");
    canvas
      .getState()
      .load(
        flow(
          [trigger("go"), use, output("end")],
          [thenWire("go", "use"), thenWire("use", "end")],
          flowSettings,
          { containers: [] },
        ),
      );

    const result = await call("read_blueprint", {});

    expect(messagesOf(result)).not.toContainEqual(expect.stringMatching(missing));
  });

  it("an edit that puts a known library on the main flow reports no missing library", async () => {
    const { call, canvas } = await setup();
    canvas.getState().setLibraries([review], "flow-1");
    canvas.getState().load(
      flow([trigger("go"), use, output("end")], [thenWire("use", "end")], flowSettings, {
        containers: [],
      }),
    );

    const result = await call("wire", thenWire("go", "use"));

    expect(result).toMatchObject({ ok: true });
    expect(messagesOf(result)).not.toContainEqual(expect.stringMatching(missing));
  });

  it("read_blueprint of another saved blueprint does not report a known library as missing", async () => {
    const { call, canvas, blueprints } = await setup();
    canvas.getState().setLibraries([review], "flow-1");
    blueprints.push({
      flowId: "flow-host",
      name: "Host",
      flow: flow(
        [trigger("go"), use, output("end")],
        [thenWire("go", "use"), thenWire("use", "end")],
        flowSettings,
        { containers: [] },
      ),
    });

    const result = await call("read_blueprint", { blueprint: "flow-host" });

    expect(result).toMatchObject({ ok: true });
    expect(messagesOf(result)).not.toContainEqual(expect.stringMatching(missing));
  });

  it("still reports a library the lookup does not know", async () => {
    const { call, canvas } = await setup();
    canvas
      .getState()
      .load(
        flow(
          [trigger("go"), use, output("end")],
          [thenWire("go", "use"), thenWire("use", "end")],
          flowSettings,
          { containers: [] },
        ),
      );

    const result = await call("read_blueprint", {});

    expect(messagesOf(result)).toContainEqual(expect.stringMatching(missing));
  });
});

describe("tool handler adds and changes library nodes", () => {
  const library = (flowId: string, name: string, kind: BlueprintKind, uses: string[] = []) => ({
    ...flowSummary(flowId, kind, uses),
    name,
  });

  const libraries = [
    library("flow-1", "Plan", "workflow"),
    library("f-review", "Review", "node-library"),
    library("f-other", "Other", "node-library"),
    library("f-sessions", "Sessions", "session-library"),
    library("f-draft", "Draft", "incomplete"),
    library("f-flow", "Whole flow", "workflow"),
    library("f-outer", "Outer", "node-library", ["flow-1"]),
    library("f-shared", "Shared", "node-library", ["f-review"]),
    library("f-unsafe", "Android/App", "node-library"),
  ];

  const libraryAt = (id: string, libraryId: string, label: string) => ({
    id,
    type: "library",
    label,
    position: { x: 200, y: 0 },
    settings: { libraryId, label, overrides: { "session-9": { model: "opus" } } },
  });

  const ready = async (openFlowId: string | null = "flow-1") => {
    const handler = await setup();
    handler.canvas.getState().setLibraries(libraries, openFlowId);
    return handler;
  };

  const withUseIn = async (libraryId: string, label: string, inSession = true) => {
    const handler = await ready();
    const use = libraryAt("use", libraryId, label);
    handler.canvas.getState().load(
      inSession
        ? flow([trigger("start"), use, agent("agent-1")], [thenWire("start", "use")])
        : flow([trigger("go"), use, output("end")], [thenWire("go", "use")], flowSettings, {
            containers: [],
          }),
    );
    return handler;
  };

  const nameOf = (lookup: LibraryLookup) => (id: string) => lookup(id)?.name;

  const useReason = (after: Flow, nodeId: string, lookup: LibraryLookup) => {
    const problem = libraryUse
      .check(after, { libraries: lookup })
      .find(({ node }) => node === nodeId);
    if (problem === undefined) return expect.fail(`no library-use problem for ${nodeId}`);
    return reasonNaming(problem.node, problem.message, labelIn(after, nodeId));
  };

  const placed = (before: Flow, libraryId: string, name: string, parent?: string): Flow => {
    const id = nextNodeId("library", before);
    const label = libraryLabelFor(before, name);
    const node = {
      ...libraryAt(id, libraryId, label),
      settings: { libraryId, label, overrides: {} },
    };
    return {
      ...before,
      nodes: [...before.nodes, node as Node],
      containers: before.containers.map((container) =>
        container.id === parent ? { ...container, nodes: [...container.nodes, id] } : container,
      ),
    };
  };

  const changed = (before: Flow, libraryId: string, name: string): Flow => ({
    ...before,
    nodes: before.nodes.map((node) => {
      if (node.id !== "use") return node;
      const label = libraryLabelFor(before, name, "use");
      return { ...node, label, settings: { libraryId, label, overrides: {} } } as Node;
    }),
  });

  const unchanged = (canvas: Awaited<ReturnType<typeof setup>>["canvas"]) => {
    const { flow: kept, undoStack } = canvas.getState();
    return () => {
      expect(canvas.getState().flow).toBe(kept);
      expect(canvas.getState().undoStack).toEqual(undoStack);
    };
  };

  const nodeIn = (current: Flow, id: string) => current.nodes.find((node) => node.id === id);

  it("adds a node library inside a session with the canvas's label, and a second with -2", async () => {
    const { call, canvas } = await ready();
    const before = canvas.getState().flow;

    const first = await call("add_node", {
      type: "library",
      label: "Given",
      parent: "session-1",
      settings: { libraryId: "f-review" },
    });
    const middle = canvas.getState().flow;
    const second = await call("add_node", {
      type: "library",
      label: "Given",
      parent: "session-1",
      settings: { libraryId: "f-review" },
    });

    const firstLabel = libraryLabelFor(before, "Review");
    const secondLabel = libraryLabelFor(middle, "Review");
    expect(first).toMatchObject({ ok: true, nodeId: "library-1" });
    expect(second).toMatchObject({ ok: true, nodeId: "library-2" });
    const after = canvas.getState().flow;
    expect(nodeIn(after, "library-1")).toMatchObject({
      label: firstLabel,
      settings: { libraryId: "f-review", label: firstLabel, overrides: {} },
    });
    expect(nodeIn(after, "library-2")).toMatchObject({
      label: secondLabel,
      settings: { label: secondLabel },
    });
    expect(secondLabel).toBe(`${firstLabel}-2`);
    expect(after.containers.find(({ id }) => id === "session-1")?.nodes).toContain("library-2");
  });

  it.each([
    ["a session library", "f-sessions", "Sessions"],
    ["an incomplete library", "f-draft", "Draft"],
    ["a workflow", "f-flow", "Whole flow"],
    ["a library that does not exist", "ghost", "library"],
  ])(
    "refuses to add %s inside a session with the canvas's reason, changing nothing",
    async (_, libraryId, name) => {
      const { call, canvas } = await ready();
      const before = canvas.getState().flow;
      const expectUnchanged = unchanged(canvas);

      const result = await call("add_node", {
        type: "library",
        label: "Given",
        parent: "session-1",
        settings: { libraryId },
      });

      const { libraries: lookup } = canvas.getState();
      const reason = useReason(placed(before, libraryId, name, "session-1"), "library-1", lookup);
      expect(result).toEqual({
        ok: false,
        reason: `Can't add ${name} into ${labelIn(before, "session-1")}: ${reason}`,
      });
      expectUnchanged();
    },
  );

  it.each([
    ["the open blueprint itself", "flow-1", "Plan", ["flow-1", "flow-1"]],
    ["a library that uses the open blueprint", "f-outer", "Outer", ["flow-1", "f-outer", "flow-1"]],
  ])("refuses to add %s, naming the loop", async (_, libraryId, name, path) => {
    const { call, canvas } = await ready();
    const before = canvas.getState().flow;
    const expectUnchanged = unchanged(canvas);

    const result = await call("add_node", {
      type: "library",
      label: "Given",
      parent: "session-1",
      settings: { libraryId },
    });

    const reason = loopReason(path, nameOf(canvas.getState().libraries));
    expect(result).toEqual({
      ok: false,
      reason: `Can't add ${name} into ${labelIn(before, "session-1")}: ${reason}`,
    });
    expectUnchanged();
  });

  it.each([
    ["a node library inside the workspace", "f-review", "workspace-1"],
    ["a node library loose in a workflow", "f-review", undefined],
    ["a session library loose in a workflow", "f-sessions", undefined],
    ["a library other libraries also use", "f-review", "session-1"],
    ["a library that uses another library", "f-shared", "session-1"],
  ])("adds %s", async (_, libraryId, parent) => {
    const { call, canvas } = await ready();

    const result = await call("add_node", {
      type: "library",
      label: "Given",
      settings: { libraryId },
      ...(parent === undefined ? {} : { parent }),
    });

    expect(result).toMatchObject({ ok: true, nodeId: "library-1" });
    expect(nodeIn(canvas.getState().flow, "library-1")).toMatchObject({ settings: { libraryId } });
  });

  it.each([
    ["an Agent", { type: "agent", label: "Given", settings: { instructions: "Review it." } }],
    ["a node library", { type: "library", label: "Given", settings: { libraryId: "f-review" } }],
  ])("answers %s added loose in a workflow with the loose-node problem", async (_, input) => {
    const { call, canvas } = await ready();
    const before = canvas.getState().flow;

    const result = await call("add_node", input);

    const added = canvas.getState().flow.nodes.find((node) => !before.nodes.includes(node));
    if (added === undefined) return expect.fail("nothing added");
    expect(result).toEqual({
      ok: true,
      nodeId: added.id,
      problems: [
        {
          rule: "outside-container",
          node: added.id,
          message: `${added.label} is outside every workspace and session; move it into one.`,
        },
      ],
    });
  });

  it("adds a node library loose in a blueprint with no workspace", async () => {
    const { call, canvas } = await ready();
    canvas.getState().load(
      flow([trigger("go"), output("end")], [thenWire("go", "end")], flowSettings, {
        containers: [],
      }),
    );

    const result = await call("add_node", {
      type: "library",
      label: "Given",
      settings: { libraryId: "f-review" },
    });

    expect(result).toMatchObject({ ok: true, nodeId: "library-1" });
  });

  it("finds no loop back to the open blueprint when none is open", async () => {
    const { call, canvas } = await ready(null);

    const result = await call("add_node", {
      type: "library",
      label: "Given",
      parent: "session-1",
      settings: { libraryId: "f-outer" },
    });

    expect(result).toMatchObject({ ok: true, nodeId: "library-1" });
    expect(canvas.getState().flow.nodes.some(({ id }) => id === "library-1")).toBe(true);
  });

  it("applies a library whose name makes an unsafe label, reporting the label problem", async () => {
    const { call, canvas } = await ready();
    canvas.getState().load(flow([agent("a1")], []));

    const result = await call("add_node", {
      type: "library",
      label: "Given",
      parent: "session-1",
      settings: { libraryId: "f-unsafe" },
    });

    expect(result).toMatchObject({
      ok: true,
      nodeId: "library-1",
      problems: expect.arrayContaining([expect.objectContaining({ rule: "library-labels" })]),
    });
  });

  it("reports the label problem of an unsafe library added unwired into a session with a Start", async () => {
    const { call } = await ready();

    const result = await call("add_node", {
      type: "library",
      label: "Given",
      parent: "session-1",
      settings: { libraryId: "f-unsafe" },
    });

    expect(result).toMatchObject({
      ok: true,
      nodeId: "library-1",
      problems: [expect.objectContaining({ rule: "library-labels", node: "library-1" })],
    });
  });

  it("changes a library node's libraryId, re-deriving its label and clearing old overrides", async () => {
    const { call, canvas } = await withUseIn("f-review", "review");
    const before = canvas.getState().flow;

    const result = await call("change_node", { nodeId: "use", settings: { libraryId: "f-other" } });

    const label = libraryLabelFor(before, "Other", "use");
    expect(result).toMatchObject({ ok: true });
    expect(nodeIn(canvas.getState().flow, "use")).toMatchObject({
      label,
      settings: { libraryId: "f-other", label, overrides: {} },
    });
  });

  it.each([
    ["a session library", "f-sessions", "Sessions"],
    ["an incomplete library", "f-draft", "Draft"],
    ["a workflow", "f-flow", "Whole flow"],
  ])(
    "refuses to change a node in a session to %s with the canvas's reason",
    async (_, libraryId, name) => {
      const { call, canvas } = await withUseIn("f-review", "review");
      const before = canvas.getState().flow;
      const expectUnchanged = unchanged(canvas);

      const result = await call("change_node", { nodeId: "use", settings: { libraryId } });

      const reason = useReason(
        changed(before, libraryId, name),
        "use",
        canvas.getState().libraries,
      );
      expect(result).toEqual({ ok: false, reason: `Can't use ${name} here: ${reason}` });
      expectUnchanged();
    },
  );

  it("refuses a libraryId that makes a loop, naming it", async () => {
    const { call, canvas } = await withUseIn("f-review", "review");
    const expectUnchanged = unchanged(canvas);

    const result = await call("change_node", { nodeId: "use", settings: { libraryId: "f-outer" } });

    const reason = loopReason(["flow-1", "f-outer", "flow-1"], nameOf(canvas.getState().libraries));
    expect(result).toEqual({ ok: false, reason: `Can't use Outer here: ${reason}` });
    expectUnchanged();
  });

  it("changes a loose node library to a session library", async () => {
    const { call, canvas } = await withUseIn("f-review", "review", false);

    const result = await call("change_node", {
      nodeId: "use",
      settings: { libraryId: "f-sessions" },
    });

    expect(result).toMatchObject({ ok: true });
    expect(nodeIn(canvas.getState().flow, "use")).toMatchObject({
      settings: { libraryId: "f-sessions" },
    });
  });

  it("runs no library check and keeps overrides when the libraryId stays the same", async () => {
    const { call, canvas } = await withUseIn("f-sessions", "sessions");

    const result = await call("change_node", {
      nodeId: "use",
      label: "Mine",
      settings: { libraryId: "f-sessions" },
    });

    expect(result).toMatchObject({ ok: true });
    expect(nodeIn(canvas.getState().flow, "use")).toMatchObject({
      label: "Mine",
      settings: { libraryId: "f-sessions", overrides: { "session-9": { model: "opus" } } },
    });
  });
});

describe("tool handler and connections between sessions", () => {
  const twoSessions = (): Flow =>
    flow(
      [
        trigger("w-start"),
        output("w-stop"),
        trigger("a1"),
        output("a2"),
        trigger("i1"),
        output("i2"),
      ],
      [thenWire("w-start", "w-stop"), thenWire("a1", "a2"), thenWire("i1", "i2")],
      flowSettings,
      {
        containers: [
          workspaceContainer(["w-start", "w-stop"]),
          sessionContainer(["a1", "a2"], { id: "android", name: "android" }),
          sessionContainer(["i1", "i2"], { id: "ios", name: "ios" }),
        ],
      },
    );

  const onTwoSessions = async () => {
    const handler = await setup();
    handler.canvas.getState().load(twoSessions());
    return handler;
  };

  const canvasToast = (current: Flow, a: string, b: string) => {
    const store = createCanvasStore();
    store.getState().load(current);
    store.getState().connectSessions(a, b);
    return store.getState().message;
  };

  it("add_connection connects two sessions in the ask's one undo step", async () => {
    const { call, canvas } = await onTwoSessions();
    const before = canvas.getState().flow;

    const result = await call("add_connection", { between: ["android", "ios"] });

    expect(result).toEqual({ ok: true, connectionId: "c1", problems: [] });
    expect(canvas.getState().flow.connections).toEqual([{ id: "c1", between: ["android", "ios"] }]);
    expect(canvas.getState().undoStack).toHaveLength(1);

    canvas.getState().undo();
    expect(canvas.getState().flow).toEqual(before);
    expect(canvas.getState().flow.connections ?? []).toEqual([]);
  });

  it.each([
    ["the same session on both ends", ["android", "android"]],
    ["the connected pair again", ["android", "ios"]],
    ["the connected pair reversed", ["ios", "android"]],
    ["a node", ["android", "a1"]],
    ["the workspace", ["workspace-1", "ios"]],
  ] as [string, [string, string]][])(
    "add_connection refuses %s with the canvas's own reason and leaves the flow alone",
    async (_name, between) => {
      const { call, canvas } = await onTwoSessions();
      await call("add_connection", { between: ["android", "ios"] });
      const before = canvas.getState().flow;
      const toast = canvasToast(before, ...between);

      const result = await call("add_connection", { between });

      expect(toast).toEqual(expect.stringMatching(/\S/));
      expect(result).toEqual({ ok: false, reason: toast });
      expect(canvas.getState().flow).toBe(before);
    },
  );

  it("delete_connection removes a connection, and undo brings it back", async () => {
    const { call, canvas, endTurn } = await onTwoSessions();
    await call("add_connection", { between: ["android", "ios"] });
    endTurn();
    const before = canvas.getState().flow;

    const result = await call("delete_connection", { connectionId: "c1" });

    expect(result).toEqual({ ok: true, problems: [] });
    expect(canvas.getState().flow.connections ?? []).toEqual([]);

    canvas.getState().undo();
    expect(canvas.getState().flow).toEqual(before);
  });

  it("delete_connection refuses a connection not in the blueprint", async () => {
    const { call, canvas } = await onTwoSessions();
    const before = canvas.getState().flow;

    const result = await call("delete_connection", { connectionId: "c7" });

    expect(result).toEqual({ ok: false, reason: 'No connection "c7" in the blueprint.' });
    expect(canvas.getState().flow).toBe(before);
  });
});
