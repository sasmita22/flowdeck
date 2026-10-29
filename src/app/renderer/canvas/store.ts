import { createStore, type StoreApi } from "zustand/vanilla";
import { validate } from "../../../core/compiler/validate.js";
import type { Flow, Node, Wire } from "../../../core/flow/schema.js";
import * as promptDefaults from "../../../core/nodes/prompt/defaults.js";
import * as scriptDefaults from "../../../core/nodes/script/defaults.js";
import {
  addNode,
  addWire,
  deleteNodes as deleteNodesCommand,
  moveNodes,
  type Command,
  type Move,
} from "./commands.js";

export type CanvasNodeType = "prompt" | "script";

export type WireEnd = { node: string; port: string };

type Position = { x: number; y: number };

export interface CanvasState {
  flow: Flow;
  selection: string[];
  undoStack: Command[];
  redoStack: Command[];
  dragPositions: Record<string, Position>;
  drop(type: CanvasNodeType, position: Position): void;
  connect(from: WireEnd, to: WireEnd): boolean;
  deleteNodes(ids: readonly string[]): void;
  deleteSelection(): void;
  select(ids: readonly string[]): void;
  dragTo(id: string, position: Position): void;
  endDrag(ids: readonly string[]): void;
  undo(): void;
  redo(): void;
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

export const nextNodeId = (type: CanvasNodeType, flow: Flow): string => {
  const used = new Set(flow.nodes.map((node) => node.id.toLowerCase()));
  let n = 1;
  while (used.has(`${type}-${n}`)) n += 1;
  return `${type}-${n}`;
};

const newNode = (type: CanvasNodeType, id: string, { x, y }: Position): Node =>
  type === "prompt"
    ? {
        id,
        type,
        label: promptDefaults.defaultLabel,
        position: { x, y },
        settings: { ...promptDefaults.defaultSettings },
      }
    : {
        id,
        type,
        label: scriptDefaults.defaultLabel,
        position: { x, y },
        settings: { ...scriptDefaults.defaultSettings },
      };

const sameEnd = (a: WireEnd, b: WireEnd) => a.node === b.node && a.port === b.port;

const kept = (selection: readonly string[], flow: Flow) => {
  const ids = new Set(flow.nodes.map((node) => node.id));
  return selection.filter((id) => ids.has(id));
};

const samePosition = (a: Position, b: Position) => a.x === b.x && a.y === b.y;

export function createCanvasStore(
  deps: { nextId?: (type: CanvasNodeType, flow: Flow) => string } = {},
): StoreApi<CanvasState> {
  const nextId = deps.nextId ?? nextNodeId;

  return createStore<CanvasState>()((set, get) => {
    const run = (command: Command, selection = get().selection) => {
      const { flow, undoStack } = get();
      const next = command.do(flow);
      set({
        flow: next,
        undoStack: [...undoStack, command],
        redoStack: [],
        selection: kept(selection, next),
      });
    };

    const deleteNodes = (ids: readonly string[]) => {
      if (ids.length > 0) run(deleteNodesCommand(get().flow, ids));
    };

    return {
      flow: newCanvasFlow(),
      selection: [],
      undoStack: [],
      redoStack: [],
      dragPositions: {},

      drop: (type, position) => {
        const id = nextId(type, get().flow);
        run(addNode(newNode(type, id, position)), [id]);
      },

      connect: (from, to) => {
        const { flow } = get();
        if (flow.wires.some((wire) => sameEnd(wire.from, from) && sameEnd(wire.to, to))) {
          return false;
        }
        const command = addWire({ kind: "then", from: { ...from }, to: { ...to } } satisfies Wire);
        if (validate(command.do(flow)).length > 0) return false;
        run(command);
        return true;
      },

      deleteNodes,

      deleteSelection: () => deleteNodes(get().selection),

      select: (ids) => set({ selection: [...ids] }),

      dragTo: (id, { x, y }) =>
        set(({ dragPositions }) => ({ dragPositions: { ...dragPositions, [id]: { x, y } } })),

      endDrag: (ids) => {
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

      undo: () => {
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
    };
  });
}
