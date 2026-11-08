import { createStore, type StoreApi } from "zustand/vanilla";
import { plainReason, reasonNaming } from "../../../core/compiler/problems.js";
import { validate, type ValidationError } from "../../../core/compiler/validate.js";
import { newProblems } from "../../../core/flow/blueprint-edits.js";
import { flowsEqual } from "../../../core/flow/equal.js";
import { bodyProblems } from "../../../core/flow/structure.js";
import {
  NodeType,
  parseFlow,
  type BuildConfig,
  type CanvasNote,
  type Flow,
  type Node,
  type Port,
  type Session,
  type Variable,
  type Wire,
} from "../../../core/flow/schema.js";
import { nodeDefaults } from "../../../core/nodes/defaults.js";
import { nodeLook } from "../nodes/look.js";
import { noteLook } from "../nodes/note-look.js";
import {
  bodyOf,
  centerOf,
  containerAt,
  containerMoves,
  followed,
  isContainer,
  widthOf,
  withPositions,
} from "./frames.js";
import {
  addItems,
  addNode,
  addNote,
  addWire,
  deleteNodes as deleteNodesCommand,
  deleteWires,
  moveNodes,
  replaceWire,
  updateNode as updateNodeCommand,
  updateNote,
  updateSession,
  type Command,
  type Items,
  type Move,
} from "./commands.js";
import { edgeId } from "./view.js";

export const isNodeType = (value: string): value is NodeType => NodeType.safeParse(value).success;

export type CanvasItemType = NodeType | "note";

export const isCanvasItemType = (value: string): value is CanvasItemType =>
  value === "note" || isNodeType(value);

export { nodeDefaults };

export type WireEnd = { node: string; port: string };

type Position = { x: number; y: number };

export type NoteBox = { x: number; y: number; width: number; height: number };

export type NodeMenu = { nodeId: string; x: number; y: number };

export type Naming = { from: WireEnd; to: WireEnd };

export type Focus = { node: string; seq: number };

export interface CanvasState {
  flow: Flow;
  saved: Flow;
  ready: boolean;
  selection: string[];
  selectedWires: string[];
  highlighted: string | null;
  undoStack: Command[];
  redoStack: Command[];
  dragPositions: Record<string, Position>;
  noteBoxes: Record<string, NoteBox>;
  message: string | null;
  menu: NodeMenu | null;
  naming: Naming | null;
  clipboard: Items | null;
  pastes: number;
  renaming: string | null;
  renamingWire: string | null;
  focus: Focus | null;
  opened: number;
  drop(type: CanvasItemType, position: Position): void;
  addNext(type: CanvasItemType): void;
  editNoteText(id: string, text: string): void;
  resizeNoteLive(id: string, box: NoteBox): void;
  resizeNote(id: string, box: NoteBox): void;
  connect(from: WireEnd, to: WireEnd): boolean;
  refuseConnection(): void;
  nameFile(file: string): boolean;
  cancelNaming(): void;
  deleteNodes(ids: readonly string[]): void;
  deleteSelection(): void;
  select(ids: readonly string[]): void;
  selectWires(ids: readonly string[]): void;
  selectAll(): void;
  copy(): void;
  paste(): void;
  duplicate(): void;
  frameOnly(id: string): void;
  startRename(id?: string): void;
  rename(label: string): void;
  cancelRename(): void;
  startWireRename(edgeId: string): void;
  renameWire(file: string): void;
  cancelWireRename(): void;
  focusNode(id: string): void;
  openNodeMenu(nodeId: string, at: Position): void;
  closeNodeMenu(): void;
  highlight(id: string | null): void;
  dragTo(id: string, position: Position): void;
  endDrag(ids: readonly string[]): void;
  updateSession(next: Session): void;
  setRepo(repo: string): void;
  setBase(base: string): void;
  addVariable(): void;
  updateVariable(index: number, variable: Variable): void;
  removeVariable(index: number): void;
  updateNode(next: Node): void;
  applyAgent(command: Command): boolean;
  endAgentGroup(): void;
  variableCommand(variable: Variable): Command;
  undo(): void;
  redo(): void;
  load(input: unknown): void;
  markSaved(flow: Flow): void;
}

const freeVariableName = ({ variables }: BuildConfig) => {
  const taken = new Set(variables.map(({ name }) => name));
  let name = "variable";
  for (let n = 2; taken.has(name); n += 1) name = `variable-${n}`;
  return name;
};

export const newCanvasFlow = (): Flow => ({
  nodes: [],
  wires: [],
  session: {
    name: "main",
    buildConfig: { variables: [] },
    model: "sonnet",
    allowedTools: [],
    permissionMode: "default",
    connectors: [],
  },
});

export const nextNodeId = (type: NodeType, flow: Flow): string => {
  const used = new Set(flow.nodes.map((node) => node.id.toLowerCase()));
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

const rightEdge = (node: Node) => node.position.x + widthOf(node);

const neighbours = (flow: Flow, parent: string | undefined) =>
  parent === undefined
    ? topLevel(flow)
    : flow.nodes.filter((node) => node.id === parent || node.parent === parent);

const overlapping = (flow: Flow, type: NodeType, { x, y }: Position, parent?: string) => {
  const { width, height } = nodeLook(type).box;
  return neighbours(flow, parent).find((node) => {
    return (
      x < rightEdge(node) &&
      node.position.x < x + width &&
      y < node.position.y + nodeLook(node.type).box.height &&
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

const issuesByFlow = new WeakMap<Flow, Record<string, string[]>>();

const reasonOf = (flow: Flow, error: ValidationError) =>
  reasonNaming(error.node, error.message, labelOf(flow, error.node ?? ""));

const labelOf = (flow: Flow, id: string) => nodeLabel(flow.nodes, id);

export const labelFor = (node: Pick<Node, "type" | "label"> | undefined): string => {
  if (node === undefined) return "Build";
  return node.label.trim() === "" ? nodeDefaults[node.type].label : node.label;
};

export const nodeLabel = (nodes: readonly Node[], nodeId?: string): string => {
  if (nodeId === undefined) return labelFor(undefined);
  const node = nodes.find((candidate) => candidate.id === nodeId);
  return node ? labelFor(node) : nodeId;
};

export const selectNodeIssues = (flow: Flow): Record<string, string[]> => {
  const cached = issuesByFlow.get(flow);
  if (cached !== undefined) return cached;
  const issues: Record<string, string[]> = {};
  for (const error of validate(flow)) {
    if (error.node !== undefined)
      (issues[error.node] ??= []).push(plainReason(error.node, error.message));
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

const sessionIssuesByFlow = new WeakMap<Flow, Record<string, string>>();

export const selectSessionIssues = (flow: Flow): Record<string, string> => {
  const cached = sessionIssuesByFlow.get(flow);
  if (cached !== undefined) return cached;
  const issues: Record<string, string> = {};
  for (const { node, field, message } of validate(flow)) {
    if (node === undefined && field !== undefined && !(field in issues)) issues[field] = message;
  }
  sessionIssuesByFlow.set(flow, issues);
  return issues;
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

const cannotConnect = (flow: Flow, from: WireEnd, to: WireEnd, reason: string) =>
  `Can't connect ${labelOf(flow, from.node)} to ${labelOf(flow, to.node)}: ${reason}`;

const wrongWay =
  "Can't connect those ports: drag from a node's output on its right to another node's input on its left.";

const alreadyJoined = "they are already joined.";

const kept = (selection: readonly string[], flow: Flow) => {
  const ids = new Set([...flow.nodes, ...(flow.notes ?? [])].map(({ id }) => id));
  return selection.filter((id) => ids.has(id));
};

const samePosition = (a: Position, b: Position) => a.x === b.x && a.y === b.y;

const noteIn = (flow: Flow, id: string) => flow.notes?.find((note) => note.id === id);

const positionOf = (flow: Flow, id: string) =>
  (flow.nodes.find((node) => node.id === id) ?? noteIn(flow, id))?.position;

export const selectCanDelete = (state: Pick<CanvasState, "selection" | "selectedWires">) =>
  state.selection.length > 0 || state.selectedWires.length > 0;

const keptWires = (selected: readonly string[], flow: Flow) => {
  const present = new Set(flow.wires.map(edgeId));
  return selected.filter((id) => present.has(id));
};

const swapped = (ids: readonly string[], from: string, to: string) =>
  ids.map((id) => (id === from ? to : id));

const both = (first: Command, second: Command): Command => ({
  do: (flow) => second.do(first.do(flow)),
  undo: (flow) => first.undo(second.undo(flow)),
});

const pasteGap = 32;

const shifted = (position: Position, by: Position): Position => ({
  x: position.x + by.x,
  y: position.y + by.y,
});

export const selectDirty = (state: Pick<CanvasState, "flow" | "saved">): boolean =>
  !flowsEqual(state.flow, state.saved);

export function createCanvasStore(
  deps: { nextId?: (type: NodeType, flow: Flow) => string; ready?: boolean } = {},
): StoreApi<CanvasState> {
  const nextId = deps.nextId ?? nextNodeId;

  return createStore<CanvasState>()((set, get) => {
    const ready = () => get().ready;

    const buildConfigCommand = (edit: (config: BuildConfig) => BuildConfig) => {
      const { session } = get().flow;
      return updateSession({ ...session, buildConfig: edit(session.buildConfig) });
    };

    const editBuildConfig = (edit: (config: BuildConfig) => BuildConfig) => {
      if (ready()) run(buildConfigCommand(edit));
    };

    const wireRenames = new WeakMap<Command, { from: string; to: string }>();

    let agentGroup: Command | null = null;

    const record = (
      entry: Command,
      next: Flow,
      below: readonly Command[],
      selection = get().selection,
      wires = get().selectedWires,
    ) => {
      set({
        flow: next,
        undoStack: [...below, entry],
        redoStack: [],
        selection: kept(selection, next),
        selectedWires: keptWires(wires, next),
        message: null,
      });
    };

    const run = (command: Command, selection = get().selection, wires = get().selectedWires) => {
      agentGroup = null;
      const { flow, undoStack } = get();
      record(command, command.do(flow), undoStack, selection, wires);
    };

    const nodeDeletion = (flow: Flow, ids: readonly string[]): Command | undefined => {
      const present = flow.nodes.filter((node) => ids.includes(node.id));
      const doomed = new Set(
        present
          .flatMap((node) => [node, ...(isContainer(node) ? bodyOf(flow, node.id) : [])])
          .map((node) => node.id),
      );
      const deletable = [
        ...flow.nodes.filter((node) => doomed.has(node.id)).map((node) => node.id),
        ...(flow.notes ?? []).filter((note) => ids.includes(note.id)).map((note) => note.id),
      ];
      return deletable.length > 0 ? deleteNodesCommand(flow, deletable) : undefined;
    };

    const wireDeletion = (flow: Flow, edgeIds: readonly string[]): Command | undefined => {
      const doomed = new Set(edgeIds);
      const places = flow.wires.flatMap((wire, index) => (doomed.has(edgeId(wire)) ? [index] : []));
      return places.length > 0 ? deleteWires(flow, places) : undefined;
    };

    const deleteNodes = (ids: readonly string[]) => {
      if (!ready()) return;
      set({ menu: null });
      const command = nodeDeletion(get().flow, ids);
      if (command !== undefined) run(command);
    };

    const deleteSelection = () => {
      if (!ready()) return;
      set({ menu: null });
      const { flow, selection, selectedWires } = get();
      const nodes = nodeDeletion(flow, selection);
      const afterNodes = nodes?.do(flow) ?? flow;
      const wires = wireDeletion(afterNodes, selectedWires);
      const command =
        nodes !== undefined && wires !== undefined ? both(nodes, wires) : (nodes ?? wires);
      if (command !== undefined) run(command);
    };

    const refusal = (others: readonly Wire[], wire: Wire, command: Command): string | null => {
      const { flow } = get();
      if (others.some((existing) => sameWire(existing, wire))) {
        return cannotConnect(flow, wire.from, wire.to, alreadyJoined);
      }
      const [error] = newProblems(flow, command.do(flow));
      return error === undefined
        ? null
        : cannotConnect(flow, wire.from, wire.to, reasonOf(flow, error));
    };

    const addChecked = (wire: Wire): boolean => {
      const command = addWire(wire);
      const refused = refusal(get().flow.wires, wire, command);
      if (refused !== null) {
        set({ message: refused });
        return false;
      }
      run(command);
      return true;
    };

    const copied = (
      flow: Flow,
      ids: readonly string[],
      { body }: { body: boolean } = { body: true },
    ): Items | null => {
      const chosen = new Set(ids);
      const nodes = flow.nodes.filter(
        (node) =>
          chosen.has(node.id) || (body && node.parent !== undefined && chosen.has(node.parent)),
      );
      const notes = (flow.notes ?? []).filter((note) => chosen.has(note.id));
      if (nodes.length === 0 && notes.length === 0) return null;
      const inside = new Set(nodes.map((node) => node.id));
      const wires = body
        ? flow.wires.filter((wire) => inside.has(wire.from.node) && inside.has(wire.to.node))
        : [];
      return structuredClone({ nodes, wires, notes });
    };

    const placed = (flow: Flow, items: Items, offset: Position): Items => {
      const target = selectSelectedNode({ flow, selection: get().selection });
      const into = target !== null && isContainer(target) ? target : undefined;
      let grown = flow;
      const renamed = new Map<string, string>();
      for (const node of items.nodes) {
        const id = nextId(node.type, grown);
        renamed.set(node.id, id);
        grown = { ...grown, nodes: [...grown.nodes, { ...node, id }] };
      }
      const exists = (id: string) => flow.nodes.some((node) => node.id === id);
      const parentOf = (node: Node): string | undefined => {
        if (node.parent !== undefined && renamed.has(node.parent)) return renamed.get(node.parent);
        if (into !== undefined && !isContainer(node)) return into.id;
        return node.parent !== undefined && exists(node.parent) ? node.parent : undefined;
      };
      const nodes = items.nodes.map((node): Node => {
        const rest = { ...node };
        delete rest.parent;
        const parent = parentOf(node);
        return {
          ...rest,
          id: renamed.get(node.id) ?? node.id,
          position: shifted(node.position, offset),
          ...(parent === undefined ? {} : { parent }),
        } as Node;
      });
      const wires = items.wires.map((wire) => ({
        ...wire,
        from: { ...wire.from, node: renamed.get(wire.from.node) ?? wire.from.node },
        to: { ...wire.to, node: renamed.get(wire.to.node) ?? wire.to.node },
      }));
      let withNotes: Flow = grown;
      const notes = items.notes.map((note) => {
        const id = nextNoteId(withNotes);
        const moved = { ...note, id, position: shifted(note.position, offset) };
        withNotes = { ...withNotes, notes: [...(withNotes.notes ?? []), moved] };
        return moved;
      });
      return { nodes, wires, notes };
    };

    const pasteItems = (items: Items, offset: Position): boolean => {
      const { flow } = get();
      const target = selectSelectedNode({ flow, selection: get().selection });
      const pasted = placed(flow, items, offset);
      const command = addItems(pasted);
      const after = command.do(flow);
      const pastedIds = new Set(pasted.nodes.map(({ id }) => id));
      const misplaced = bodyProblems(after.nodes).find(
        (problem) =>
          pastedIds.has(problem.node) && (problem.outOfPlace === true || problem.nested === true),
      );
      if (misplaced !== undefined) {
        const into =
          target !== null && isContainer(target) ? ` into ${labelOf(after, target.id)}` : "";
        const reason = reasonNaming(
          misplaced.node,
          `${misplaced.message}.`,
          labelOf(after, misplaced.node),
        );
        set({ message: `Can't paste${into}: ${reason}` });
        return false;
      }
      run(
        command,
        [...pasted.nodes, ...pasted.notes].map(({ id }) => id),
      );
      return true;
    };

    const start = newCanvasFlow();

    return {
      flow: start,
      saved: start,
      ready: deps.ready ?? true,
      selection: [],
      selectedWires: [],
      highlighted: null,
      undoStack: [],
      redoStack: [],
      dragPositions: {},
      noteBoxes: {},
      message: null,
      menu: null,
      naming: null,
      clipboard: null,
      pastes: 0,
      renaming: null,
      renamingWire: null,
      focus: null,
      opened: 0,

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
        const [misplaced] = newProblems(flow, command.do(flow)).filter(
          (error) => error.rule === "body-nodes",
        );
        if (misplaced !== undefined) {
          set({
            message: `Can't drop ${nodeDefaults[type].label} into ${labelOf(flow, parent ?? "")}: ${reasonOf(command.do(flow), misplaced)}`,
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
            set({
              message: cannotConnect(flow, from, to, "a file port joins only another file port."),
            });
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

      refuseConnection: () => {
        if (ready()) set({ message: wrongWay });
      },

      cancelNaming: () => set({ naming: null }),

      deleteNodes,

      deleteSelection,

      select: (ids) => set({ selection: [...ids], message: null, menu: null }),

      selectWires: (ids) => set({ selectedWires: [...ids], message: null, menu: null }),

      selectAll: () => {
        const { flow, select } = get();
        select([...flow.nodes, ...(flow.notes ?? [])].map(({ id }) => id));
      },

      copy: () => {
        if (!ready()) return;
        const items = copied(get().flow, get().selection);
        if (items !== null) set({ clipboard: items, pastes: 0 });
      },

      paste: () => {
        const { clipboard, pastes } = get();
        if (!ready() || clipboard === null) return;
        const step = (pastes + 1) * pasteGap;
        if (pasteItems(clipboard, { x: step, y: step })) set({ pastes: pastes + 1 });
      },

      duplicate: () => {
        if (!ready()) return;
        const items = copied(get().flow, get().selection);
        if (items !== null) pasteItems(items, { x: pasteGap, y: pasteGap });
      },

      frameOnly: (id) => {
        if (!ready()) return;
        set({ menu: null });
        const items = copied(get().flow, [id], { body: false });
        if (items !== null) pasteItems(items, { x: pasteGap, y: pasteGap });
      },

      startRename: (id) => {
        if (!ready()) return;
        const { flow, selection } = get();
        const target = id ?? (selection.length === 1 ? selection[0] : undefined);
        if (target === undefined || !flow.nodes.some((node) => node.id === target)) return;
        set({ renaming: target, selection: [target], menu: null });
      },

      rename: (label) => {
        const { renaming, flow } = get();
        set({ renaming: null });
        const node = flow.nodes.find((candidate) => candidate.id === renaming);
        const name = label.trim();
        if (!ready() || node === undefined || name === "" || name === node.label) return;
        run(updateNodeCommand({ ...node, label: name }));
      },

      cancelRename: () => set({ renaming: null }),

      startWireRename: (id) => {
        if (!ready()) return;
        if (!get().flow.wires.some((wire) => wire.kind === "file" && edgeId(wire) === id)) return;
        set({ renamingWire: id, menu: null });
      },

      renameWire: (file) => {
        const { renamingWire, flow, selectedWires } = get();
        set({ renamingWire: null });
        const old = flow.wires.find((wire) => edgeId(wire) === renamingWire);
        const name = file.trim();
        if (!ready() || old?.kind !== "file" || name === old.file) return;
        const next: Wire = { ...old, file: name };
        const command = replaceWire(old, next);
        const others = flow.wires.filter((wire) => wire !== old);
        const refused = refusal(others, next, command);
        if (refused !== null) {
          set({ message: refused });
          return;
        }
        const ids = { from: edgeId(old), to: edgeId(next) };
        wireRenames.set(command, ids);
        run(command, get().selection, swapped(selectedWires, ids.from, ids.to));
      },

      cancelWireRename: () => set({ renamingWire: null }),

      focusNode: (id) => {
        set({
          selection: [id],
          selectedWires: [],
          menu: null,
          focus: { node: id, seq: (get().focus?.seq ?? 0) + 1 },
        });
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
          const [error] = newProblems(flow, command.do(flow)).filter(
            (candidate) => candidate.rule !== "loop-body",
          );
          if (error !== undefined) {
            const { from, to } = nested.parent;
            const where = to === undefined ? `out of ${from ?? ""}` : `into ${to}`;
            set({
              message: `Can't move ${labelOf(flow, nested.id)} ${where}: ${reasonOf(command.do(flow), error)}`,
            });
            return;
          }
        }
        run(command);
      },

      updateSession: (next) => {
        if (ready()) run(updateSession(next));
      },

      setRepo: (repo) => editBuildConfig((config) => ({ ...config, repo })),

      setBase: (base) =>
        editBuildConfig(({ repo, variables }) => ({
          ...(repo === undefined ? {} : { repo }),
          ...(base === "" ? {} : { base }),
          variables,
        })),

      addVariable: () =>
        editBuildConfig((config) => ({
          ...config,
          variables: [...config.variables, { name: freeVariableName(config), kind: "text" }],
        })),

      updateVariable: (index, variable) =>
        editBuildConfig((config) => ({
          ...config,
          variables: config.variables.map((current, at) => (at === index ? variable : current)),
        })),

      removeVariable: (index) =>
        editBuildConfig((config) => ({
          ...config,
          variables: config.variables.filter((_variable, at) => at !== index),
        })),

      updateNode: (next) => {
        if (!ready()) return;
        const { flow } = get();
        const current = flow.nodes.find((node) => node.id === next.id);
        const alone = (node: Node): Flow => ({ ...flow, nodes: [node] });
        if (current === undefined || flowsEqual(alone(current), alone(next))) return;
        run(updateNodeCommand(next));
      },

      applyAgent: (command) => {
        if (!ready()) return false;
        const { flow, undoStack } = get();
        const group = agentGroup === null ? command : both(agentGroup, command);
        record(group, command.do(flow), agentGroup === null ? undoStack : undoStack.slice(0, -1));
        agentGroup = group;
        return true;
      },

      endAgentGroup: () => {
        agentGroup = null;
      },

      variableCommand: (variable) =>
        buildConfigCommand((config) => ({
          ...config,
          variables: config.variables.some(({ name }) => name === variable.name)
            ? config.variables.map((current) =>
                current.name === variable.name ? variable : current,
              )
            : [...config.variables, variable],
        })),

      undo: () => {
        if (!ready()) return;
        agentGroup = null;
        const { flow, undoStack, redoStack, selection } = get();
        const command = undoStack.at(-1);
        if (command === undefined) return;
        const next = command.undo(flow);
        const renamed = wireRenames.get(command);
        const wires = get().selectedWires;
        set({
          flow: next,
          undoStack: undoStack.slice(0, -1),
          redoStack: [...redoStack, command],
          selection: kept(selection, next),
          selectedWires: keptWires(
            renamed === undefined ? wires : swapped(wires, renamed.to, renamed.from),
            next,
          ),
        });
      },

      redo: () => {
        if (!ready()) return;
        agentGroup = null;
        const { flow, undoStack, redoStack, selection } = get();
        const command = redoStack.at(-1);
        if (command === undefined) return;
        const next = command.do(flow);
        const renamed = wireRenames.get(command);
        const wires = get().selectedWires;
        set({
          flow: next,
          undoStack: [...undoStack, command],
          redoStack: redoStack.slice(0, -1),
          selection: kept(selection, next),
          selectedWires: keptWires(
            renamed === undefined ? wires : swapped(wires, renamed.from, renamed.to),
            next,
          ),
        });
      },

      load: (input) => {
        const flow = parseFlow(input);
        agentGroup = null;
        set({
          flow,
          saved: flow,
          ready: true,
          selection: [],
          selectedWires: [],
          undoStack: [],
          redoStack: [],
          dragPositions: {},
          noteBoxes: {},
          renaming: null,
          renamingWire: null,
          focus: null,
          opened: get().opened + 1,
        });
      },

      markSaved: (flow) => {
        agentGroup = null;
        set({ saved: flow });
      },
    };
  });
}
