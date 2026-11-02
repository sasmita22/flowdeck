import { createStore, type StoreApi } from "zustand/vanilla";
import { validate, type ValidationError } from "../../../core/compiler/validate.js";
import { flowsEqual } from "../../../core/flow/equal.js";
import {
  NodeType,
  parseFlow,
  type Flow,
  type Node,
  type Session,
  type Wire,
} from "../../../core/flow/schema.js";
import * as promptDefaults from "../../../core/nodes/prompt/defaults.js";
import * as scriptDefaults from "../../../core/nodes/script/defaults.js";
import * as agentDefaults from "../../../core/nodes/agent/defaults.js";
import * as gateDefaults from "../../../core/nodes/gate/defaults.js";
import * as askDefaults from "../../../core/nodes/ask/defaults.js";
import * as hardstopDefaults from "../../../core/nodes/hardstop/defaults.js";
import * as loopDefaults from "../../../core/nodes/loop/defaults.js";
import * as triggerDefaults from "../../../core/nodes/trigger/defaults.js";
import * as outputDefaults from "../../../core/nodes/output/defaults.js";
import * as forkDefaults from "../../../core/nodes/fork/defaults.js";
import * as joinDefaults from "../../../core/nodes/join/defaults.js";
import * as foreachDefaults from "../../../core/nodes/foreach/defaults.js";
import * as branchDefaults from "../../../core/nodes/branch/defaults.js";
import { nodeLook } from "../nodes/look.js";
import {
  addNode,
  addWire,
  deleteNodes as deleteNodesCommand,
  moveNodes,
  updateNode as updateNodeCommand,
  updateSession,
  wrapInSession,
  wrappableIds,
  type Command,
  type Move,
} from "./commands.js";

export { wrappableIds };

export const isNodeType = (value: string): value is NodeType => NodeType.safeParse(value).success;

type SettingsOf<T extends NodeType> = Extract<Node, { type: T }>["settings"];

export const nodeDefaults: { [T in NodeType]: { label: string; settings: SettingsOf<T> } } = {
  prompt: { label: promptDefaults.defaultLabel, settings: promptDefaults.defaultSettings },
  script: { label: scriptDefaults.defaultLabel, settings: scriptDefaults.defaultSettings },
  agent: { label: agentDefaults.defaultLabel, settings: agentDefaults.defaultSettings },
  gate: { label: gateDefaults.defaultLabel, settings: gateDefaults.defaultSettings },
  ask: { label: askDefaults.defaultLabel, settings: askDefaults.defaultSettings },
  hardstop: { label: hardstopDefaults.defaultLabel, settings: hardstopDefaults.defaultSettings },
  loop: { label: loopDefaults.defaultLabel, settings: loopDefaults.defaultSettings },
  trigger: { label: triggerDefaults.defaultLabel, settings: triggerDefaults.defaultSettings },
  output: { label: outputDefaults.defaultLabel, settings: outputDefaults.defaultSettings },
  fork: { label: forkDefaults.defaultLabel, settings: forkDefaults.defaultSettings },
  join: { label: joinDefaults.defaultLabel, settings: joinDefaults.defaultSettings },
  foreach: { label: foreachDefaults.defaultLabel, settings: foreachDefaults.defaultSettings },
  branch: { label: branchDefaults.defaultLabel, settings: branchDefaults.defaultSettings },
};

export type WireEnd = { node: string; port: string };

type Position = { x: number; y: number };

export type NodeMenu = { nodeId: string; x: number; y: number };

const lockedMessage = "Hard stop is locked";

export interface CanvasState {
  flow: Flow;
  saved: Flow;
  ready: boolean;
  selection: string[];
  highlighted: string | null;
  undoStack: Command[];
  redoStack: Command[];
  dragPositions: Record<string, Position>;
  message: string | null;
  menu: NodeMenu | null;
  drop(type: NodeType, position: Position): void;
  addNext(type: NodeType): void;
  connect(from: WireEnd, to: WireEnd): boolean;
  deleteNodes(ids: readonly string[]): void;
  deleteSelection(): void;
  select(ids: readonly string[]): void;
  openNodeMenu(nodeId: string, at: Position): void;
  closeNodeMenu(): void;
  highlight(id: string | null): void;
  dragTo(id: string, position: Position): void;
  endDrag(ids: readonly string[]): void;
  wrapSelection(): void;
  updateSession(next: Session): void;
  updateNode(next: Node): void;
  undo(): void;
  redo(): void;
  load(input: unknown): void;
  markSaved(flow: Flow): void;
}

export const newCanvasFlow = (): Flow => ({
  nodes: [],
  wires: [],
  session: {
    name: "main",
    workingFolder: { kind: "worktree", branch: "main" },
    model: "sonnet",
    allowedTools: [],
    permissionMode: "default",
    connectors: [],
  },
});

export const nextNodeId = (type: NodeType, flow: Flow): string => {
  const used = new Set(
    [...flow.nodes.map((node) => node.id), ...(flow.session.frame?.nodes ?? [])].map((id) =>
      id.toLowerCase(),
    ),
  );
  let n = 1;
  while (used.has(`${type}-${n}`)) n += 1;
  return `${type}-${n}`;
};

const newNode = (type: NodeType, id: string, { x, y }: Position): Node =>
  ({
    id,
    type,
    label: nodeDefaults[type].label,
    position: { x, y },
    settings: structuredClone(nodeDefaults[type].settings),
  }) as Node;

const gap = 48;
const firstPosition: Position = { x: 80, y: 80 };

const topLevel = (flow: Flow) => flow.nodes.filter((node) => node.parent === undefined);

const rightEdge = (node: Node) => node.position.x + nodeLook(node.type).box.width;

const overlapping = (flow: Flow, type: NodeType, { x, y }: Position) => {
  const { width, height } = nodeLook(type).box;
  return topLevel(flow).find((node) => {
    const box = nodeLook(node.type).box;
    return (
      x < node.position.x + box.width &&
      node.position.x < x + width &&
      y < node.position.y + box.height &&
      node.position.y < y + height
    );
  });
};

export const placeNode = (flow: Flow, type: NodeType, at: Position): Position => {
  let position = { ...at };
  for (let hit = overlapping(flow, type, position); hit; hit = overlapping(flow, type, position)) {
    position = { x: rightEdge(hit) + gap, y: position.y };
  }
  return position;
};

const nextTo = (flow: Flow, selection: readonly string[]): Position => {
  const selected =
    selection.length === 1 ? flow.nodes.find((node) => node.id === selection[0]) : undefined;
  const anchor =
    selected ??
    topLevel(flow).reduce<Node | undefined>(
      (rightmost, node) =>
        rightmost === undefined || rightEdge(node) > rightEdge(rightmost) ? node : rightmost,
      undefined,
    );
  return anchor === undefined
    ? firstPosition
    : { x: rightEdge(anchor) + gap, y: anchor.position.y };
};

const sameError = (a: ValidationError, b: ValidationError) =>
  a.rule === b.rule && a.node === b.node && a.wire === b.wire && a.field === b.field;

const introducesErrors = (before: Flow, after: Flow) => {
  const known = validate(before);
  return validate(after).some((error) => !known.some((old) => sameError(old, error)));
};

const issuesByFlow = new WeakMap<Flow, Record<string, string>>();

const typeTags = new RegExp(` \\((?:${NodeType.options.join("|")})\\)`, "g");

const plainReason = (nodeId: string, message: string) => {
  const untagged = message.replace(typeTags, "");
  return untagged.startsWith(`${nodeId} `) ? untagged.slice(nodeId.length + 1) : untagged;
};

export const selectNodeIssues = (flow: Flow): Record<string, string> => {
  const cached = issuesByFlow.get(flow);
  if (cached !== undefined) return cached;
  const issues: Record<string, string> = {};
  for (const error of validate(flow)) {
    if (error.node !== undefined && !(error.node in issues))
      issues[error.node] = plainReason(error.node, error.message);
  }
  issuesByFlow.set(flow, issues);
  return issues;
};

const fieldIssuesByFlow = new WeakMap<Flow, Record<string, Record<string, string>>>();

export const selectFieldIssues = (flow: Flow, nodeId: string): Record<string, string> => {
  let byNode = fieldIssuesByFlow.get(flow);
  if (byNode === undefined) {
    byNode = {};
    for (const error of validate(flow)) {
      if (error.node === undefined || error.field === undefined) continue;
      const fields = (byNode[error.node] ??= {});
      if (!(error.field in fields)) fields[error.field] = plainReason(error.node, error.message);
    }
    fieldIssuesByFlow.set(flow, byNode);
  }
  return byNode[nodeId] ?? {};
};

export const selectSelectedNode = (state: Pick<CanvasState, "flow" | "selection">): Node | null => {
  const [id, ...more] = state.selection;
  if (id === undefined || more.length > 0) return null;
  return state.flow.nodes.find((node) => node.id === id) ?? null;
};

export const selectCanvasEmpty = (state: Pick<CanvasState, "flow">): boolean =>
  state.flow.nodes.length === 0;

const sameEnd = (a: WireEnd, b: WireEnd) => a.node === b.node && a.port === b.port;

const kept = (selection: readonly string[], flow: Flow) => {
  const ids = new Set(flow.nodes.map((node) => node.id));
  return selection.filter((id) => ids.has(id));
};

const samePosition = (a: Position, b: Position) => a.x === b.x && a.y === b.y;

export const selectDirty = (state: Pick<CanvasState, "flow" | "saved">): boolean =>
  !flowsEqual(state.flow, state.saved);

export function createCanvasStore(
  deps: { nextId?: (type: NodeType, flow: Flow) => string; ready?: boolean } = {},
): StoreApi<CanvasState> {
  const nextId = deps.nextId ?? nextNodeId;

  return createStore<CanvasState>()((set, get) => {
    const ready = () => get().ready;

    const run = (command: Command, selection = get().selection) => {
      const { flow, undoStack } = get();
      const next = command.do(flow);
      set({
        flow: next,
        undoStack: [...undoStack, command],
        redoStack: [],
        selection: kept(selection, next),
        message: null,
      });
    };

    const deleteNodes = (ids: readonly string[]) => {
      if (!ready()) return;
      set({ menu: null });
      const { flow } = get();
      const present = flow.nodes.filter((node) => ids.includes(node.id));
      const deletable = present.filter((node) => node.type !== "hardstop").map((node) => node.id);
      if (deletable.length > 0) run(deleteNodesCommand(flow, deletable));
      if (deletable.length < present.length) set({ message: lockedMessage });
    };

    const start = newCanvasFlow();

    return {
      flow: start,
      saved: start,
      ready: deps.ready ?? true,
      selection: [],
      highlighted: null,
      undoStack: [],
      redoStack: [],
      dragPositions: {},
      message: null,
      menu: null,

      drop: (type, position) => {
        if (!ready()) return;
        const { flow } = get();
        const id = nextId(type, flow);
        run(addNode(newNode(type, id, placeNode(flow, type, position))), [id]);
      },

      addNext: (type) => get().drop(type, nextTo(get().flow, get().selection)),

      connect: (from, to) => {
        if (!ready()) return false;
        const { flow } = get();
        if (flow.wires.some((wire) => sameEnd(wire.from, from) && sameEnd(wire.to, to))) {
          return false;
        }
        const command = addWire({ kind: "then", from: { ...from }, to: { ...to } } satisfies Wire);
        if (introducesErrors(flow, command.do(flow))) return false;
        run(command);
        return true;
      },

      deleteNodes,

      deleteSelection: () => deleteNodes(get().selection),

      select: (ids) => set({ selection: [...ids], message: null, menu: null }),

      openNodeMenu: (nodeId, { x, y }) => set({ menu: { nodeId, x, y } }),

      closeNodeMenu: () => set({ menu: null }),

      highlight: (id) => set({ highlighted: id }),

      dragTo: (id, { x, y }) => {
        if (!ready()) return;
        set(({ dragPositions }) => ({ dragPositions: { ...dragPositions, [id]: { x, y } } }));
      },

      endDrag: (ids) => {
        if (!ready()) return;
        const { flow, dragPositions } = get();
        const moves = ids.flatMap((id): Move[] => {
          const to = dragPositions[id];
          const from = flow.nodes.find((node) => node.id === id)?.position;
          return to === undefined || from === undefined || samePosition(from, to)
            ? []
            : [{ id, from, to }];
        });
        if (moves.length > 0) run(moveNodes(moves));
        set({ dragPositions: {} });
      },

      wrapSelection: () => {
        if (!ready()) return;
        const ids = wrappableIds(get().flow, get().selection);
        if (ids.length > 0) run(wrapInSession(ids));
      },

      updateSession: (next) => {
        if (ready()) run(updateSession(next));
      },

      updateNode: (next) => {
        if (!ready()) return;
        const { flow } = get();
        const current = flow.nodes.find((node) => node.id === next.id);
        const alone = (node: Node): Flow => ({ ...flow, nodes: [node] });
        if (current === undefined || flowsEqual(alone(current), alone(next))) return;
        run(updateNodeCommand(next));
      },

      undo: () => {
        if (!ready()) return;
        const { flow, undoStack, redoStack, selection } = get();
        const command = undoStack.at(-1);
        if (command === undefined) return;
        const next = command.undo(flow);
        set({
          flow: next,
          undoStack: undoStack.slice(0, -1),
          redoStack: [...redoStack, command],
          selection: kept(selection, next),
        });
      },

      redo: () => {
        if (!ready()) return;
        const { flow, undoStack, redoStack, selection } = get();
        const command = redoStack.at(-1);
        if (command === undefined) return;
        const next = command.do(flow);
        set({
          flow: next,
          undoStack: [...undoStack, command],
          redoStack: redoStack.slice(0, -1),
          selection: kept(selection, next),
        });
      },

      load: (input) => {
        const flow = parseFlow(input);
        set({
          flow,
          saved: flow,
          ready: true,
          selection: [],
          undoStack: [],
          redoStack: [],
          dragPositions: {},
        });
      },

      markSaved: (flow) => set({ saved: flow }),
    };
  });
}
