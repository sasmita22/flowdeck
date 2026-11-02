import { createStore, type StoreApi } from "zustand/vanilla";
import { validate, type ValidationError } from "../../../core/compiler/validate.js";
import { flowsEqual } from "../../../core/flow/equal.js";
import {
  NodeType,
  parseFlow,
  type CanvasNote,
  type Flow,
  type Node,
  type Port,
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
import { noteLook } from "../nodes/note-look.js";
import {
  bodyOf,
  centerOf,
  containerAt,
  containerMoves,
  followed,
  isContainer,
  withPositions,
} from "./frames.js";
import {
  addNode,
  addNote,
  addWire,
  deleteNodes as deleteNodesCommand,
  moveNodes,
  updateNode as updateNodeCommand,
  updateNote,
  updateSession,
  wrapInSession,
  wrappableIds,
  type Command,
  type Move,
} from "./commands.js";

export { wrappableIds };

export const isNodeType = (value: string): value is NodeType => NodeType.safeParse(value).success;

export type CanvasItemType = NodeType | "note";

export const isCanvasItemType = (value: string): value is CanvasItemType =>
  value === "note" || isNodeType(value);

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

export type NoteBox = { x: number; y: number; width: number; height: number };

export type NodeMenu = { nodeId: string; x: number; y: number };

export type Naming = { from: WireEnd; to: WireEnd };

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
  noteBoxes: Record<string, NoteBox>;
  message: string | null;
  menu: NodeMenu | null;
  naming: Naming | null;
  drop(type: CanvasItemType, position: Position): void;
  addNext(type: CanvasItemType): void;
  editNoteText(id: string, text: string): void;
  resizeNoteLive(id: string, box: NoteBox): void;
  resizeNote(id: string, box: NoteBox): void;
  connect(from: WireEnd, to: WireEnd): boolean;
  nameFile(file: string): boolean;
  cancelNaming(): void;
  deleteNodes(ids: readonly string[]): void;
  deleteSelection(): void;
  select(ids: readonly string[]): void;
  selectAll(): void;
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

export const nextNoteId = (flow: Flow): string => {
  const used = new Set([...flow.nodes, ...(flow.notes ?? [])].map(({ id }) => id.toLowerCase()));
  let n = 1;
  while (used.has(`n${n}`)) n += 1;
  return `n${n}`;
};

const newNote = (id: string, { x, y }: Position): CanvasNote => ({
  id,
  text: "",
  position: { x, y },
  size: { ...noteLook.size },
});

const newNode = (type: NodeType, id: string, { x, y }: Position, parent?: string): Node =>
  ({
    id,
    type,
    label: nodeDefaults[type].label,
    position: { x, y },
    ...(parent === undefined ? {} : { parent }),
    settings: structuredClone(nodeDefaults[type].settings),
  }) as Node;

const gap = 48;
const firstPosition: Position = { x: 80, y: 80 };

const topLevel = (flow: Flow) => flow.nodes.filter((node) => node.parent === undefined);

const rightEdge = (node: Node) => node.position.x + nodeLook(node.type).box.width;

const neighbours = (flow: Flow, parent: string | undefined) =>
  parent === undefined
    ? topLevel(flow)
    : flow.nodes.filter((node) => node.id === parent || node.parent === parent);

const overlapping = (flow: Flow, type: NodeType, { x, y }: Position, parent?: string) => {
  const { width, height } = nodeLook(type).box;
  return neighbours(flow, parent).find((node) => {
    const box = nodeLook(node.type).box;
    return (
      x < node.position.x + box.width &&
      node.position.x < x + width &&
      y < node.position.y + box.height &&
      node.position.y < y + height
    );
  });
};

export const placeNode = (flow: Flow, type: NodeType, at: Position, parent?: string): Position => {
  let position = { ...at };
  for (
    let hit = overlapping(flow, type, position, parent);
    hit;
    hit = overlapping(flow, type, position, parent)
  ) {
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

const newErrors = (before: Flow, after: Flow) => {
  const known = validate(before);
  return validate(after).filter((error) => !known.some((old) => sameError(old, error)));
};

const issuesByFlow = new WeakMap<Flow, Record<string, string>>();

const typeTags = new RegExp(` \\((?:${NodeType.options.join("|")})\\)`, "g");

const plainReason = (nodeId: string, message: string) => {
  const untagged = message.replace(typeTags, "");
  return untagged.startsWith(`${nodeId} `) ? untagged.slice(nodeId.length + 1) : untagged;
};

const reasonOf = (error: ValidationError) => error.message.replace(typeTags, "");

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
  state.flow.nodes.length === 0 && (state.flow.notes ?? []).length === 0;

const sameEnd = (a: WireEnd, b: WireEnd) => a.node === b.node && a.port === b.port;

const sameWire = (a: Wire, b: Wire) =>
  sameEnd(a.from, b.from) &&
  sameEnd(a.to, b.to) &&
  (a.kind !== "file" || b.kind !== "file" || a.file === b.file);

const portKind = (flow: Flow, end: WireEnd, direction: Port["direction"]) => {
  const node = flow.nodes.find((candidate) => candidate.id === end.node);
  if (node === undefined) return undefined;
  const ports: readonly Port[] = nodeLook(node.type).ports;
  return ports.find((port) => port.name === end.port && port.direction === direction)?.kind;
};

const cannotConnect = (from: WireEnd, to: WireEnd, reason: string) =>
  `Can't connect ${from.node} to ${to.node}: ${reason}`;

const alreadyJoined = "they are already joined.";

const kept = (selection: readonly string[], flow: Flow) => {
  const ids = new Set([...flow.nodes, ...(flow.notes ?? [])].map(({ id }) => id));
  return selection.filter((id) => ids.has(id));
};

const samePosition = (a: Position, b: Position) => a.x === b.x && a.y === b.y;

const noteIn = (flow: Flow, id: string) => flow.notes?.find((note) => note.id === id);

const positionOf = (flow: Flow, id: string) =>
  (flow.nodes.find((node) => node.id === id) ?? noteIn(flow, id))?.position;

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
      const holdsLock = (node: Node) =>
        isContainer(node) && bodyOf(flow, node.id).some((child) => child.type === "hardstop");
      const kept = new Set(present.filter(holdsLock).map((node) => node.id));
      const doomed = new Set(
        present
          .filter((node) => !kept.has(node.id))
          .flatMap((node) => [node, ...(isContainer(node) ? bodyOf(flow, node.id) : [])])
          .filter((node) => node.type !== "hardstop")
          .map((node) => node.id),
      );
      const deletable = [
        ...flow.nodes.filter((node) => doomed.has(node.id)).map((node) => node.id),
        ...(flow.notes ?? []).filter((note) => ids.includes(note.id)).map((note) => note.id),
      ];
      if (deletable.length > 0) run(deleteNodesCommand(flow, deletable));
      if (kept.size > 0 || present.some((node) => node.type === "hardstop")) {
        set({ message: lockedMessage });
      }
    };

    const addChecked = (wire: Wire): boolean => {
      const { flow } = get();
      if (flow.wires.some((existing) => sameWire(existing, wire))) {
        set({ message: cannotConnect(wire.from, wire.to, alreadyJoined) });
        return false;
      }
      const command = addWire(wire);
      const [error] = newErrors(flow, command.do(flow));
      if (error !== undefined) {
        set({ message: cannotConnect(wire.from, wire.to, reasonOf(error)) });
        return false;
      }
      run(command);
      return true;
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
      noteBoxes: {},
      message: null,
      menu: null,
      naming: null,

      drop: (type, position) => {
        if (!ready()) return;
        const { flow } = get();
        if (type === "note") {
          const id = nextNoteId(flow);
          run(addNote(newNote(id, position)), [id]);
          return;
        }
        const id = nextId(type, flow);
        const parent = isContainer({ type }) ? undefined : containerAt(flow, position);
        const at = placeNode(flow, type, position, parent);
        const command = addNode(newNode(type, id, at, parent));
        const [misplaced] = newErrors(flow, command.do(flow)).filter(
          (error) => error.rule === "body-nodes",
        );
        if (misplaced !== undefined) {
          set({
            message: `Can't drop ${nodeDefaults[type].label} into ${parent ?? ""}: ${reasonOf(misplaced)}`,
          });
          return;
        }
        run(command, [id]);
      },

      addNext: (type) => get().drop(type, nextTo(get().flow, get().selection)),

      editNoteText: (id, text) => {
        if (!ready()) return;
        const note = noteIn(get().flow, id);
        if (note === undefined || note.text === text) return;
        run(updateNote({ ...note, text }));
      },

      resizeNoteLive: (id, box) => {
        if (!ready()) return;
        set(({ noteBoxes }) => ({ noteBoxes: { ...noteBoxes, [id]: { ...box } } }));
      },

      resizeNote: (id, { x, y, width, height }) => {
        if (!ready()) return;
        set(({ noteBoxes }) => ({
          noteBoxes: Object.fromEntries(Object.entries(noteBoxes).filter(([key]) => key !== id)),
        }));
        const note = noteIn(get().flow, id);
        if (note === undefined) return;
        const size = {
          width: Math.max(width, noteLook.minSize.width),
          height: Math.max(height, noteLook.minSize.height),
        };
        const { position: from, size: was } = note;
        if (samePosition(from, { x, y }) && size.width === was.width && size.height === was.height)
          return;
        run(updateNote({ ...note, position: { x, y }, size }));
      },

      connect: (from, to) => {
        if (!ready()) return false;
        const { flow } = get();
        const kinds = [portKind(flow, from, "out"), portKind(flow, to, "in")];
        if (kinds.includes("file")) {
          if (kinds[0] !== kinds[1]) {
            set({ message: cannotConnect(from, to, "a file port joins only another file port.") });
            return false;
          }
          set({ naming: { from: { ...from }, to: { ...to } }, message: null });
          return false;
        }
        return addChecked({ kind: "then", from: { ...from }, to: { ...to } });
      },

      nameFile: (file) => {
        const { naming } = get();
        if (!ready() || naming === null) return false;
        const added = addChecked({
          kind: "file",
          from: { ...naming.from },
          to: { ...naming.to },
          file: file.trim(),
        });
        if (added) set({ naming: null });
        return added;
      },

      cancelNaming: () => set({ naming: null }),

      deleteNodes,

      deleteSelection: () => deleteNodes(get().selection),

      select: (ids) => set({ selection: [...ids], message: null, menu: null }),
      selectAll: () => {
        const { flow, select } = get();
        select([...flow.nodes, ...(flow.notes ?? [])].map(({ id }) => id));
      },

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
        const dragged = Object.fromEntries(
          ids.flatMap((id) => {
            const position = dragPositions[id];
            return position === undefined ? [] : [[id, position] as const];
          }),
        );
        const targets = followed(flow, dragged);
        const framing = withPositions(flow, containerMoves(flow, dragged));
        const moved = withPositions(flow, targets);
        const parentOf = (node: Node): Move["parent"] => {
          if (isContainer(node) || !(node.id in dragged)) return undefined;
          if (node.parent !== undefined && node.parent in dragged) return undefined;
          const to = containerAt(framing, centerOf(node));
          return to === node.parent ? undefined : { from: node.parent, to };
        };
        const moves = Object.entries(targets).flatMap(([id, to]): Move[] => {
          const from = positionOf(flow, id);
          const node = moved.nodes.find((candidate) => candidate.id === id);
          const parent = node === undefined ? undefined : parentOf(node);
          if (from === undefined || (samePosition(from, to) && parent === undefined)) return [];
          return [{ id, from, to, ...(parent === undefined ? {} : { parent }) }];
        });
        set({ dragPositions: {} });
        if (moves.length === 0) return;
        const command = moveNodes(moves);
        const nested = moves.find((move) => move.parent !== undefined);
        if (nested?.parent !== undefined) {
          const [error] = newErrors(flow, command.do(flow)).filter(
            (candidate) => candidate.rule !== "loop-body",
          );
          if (error !== undefined) {
            const { from, to } = nested.parent;
            const where = to === undefined ? `out of ${from ?? ""}` : `into ${to}`;
            set({ message: `Can't move ${nested.id} ${where}: ${reasonOf(error)}` });
            return;
          }
        }
        run(command);
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
          noteBoxes: {},
        });
      },

      markSaved: (flow) => set({ saved: flow }),
    };
  });
}
