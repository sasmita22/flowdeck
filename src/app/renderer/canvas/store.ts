import { createStore, type StoreApi } from "zustand/vanilla";
import { plainReason, reasonNaming } from "../../../core/compiler/problems.js";
import { flowProblems } from "../../../core/compiler/flow-problems.js";
import type { ValidationError } from "../../../core/compiler/validate.js";
import {
  connectionRefusal,
  newProblems,
  nextConnectionId,
} from "../../../core/flow/blueprint-edits.js";
import type { FlowSummary } from "../../../core/flow/flow-store.js";
import { labelIn, libraryRefusal, loopRefusal } from "../../../core/flow/library-checks.js";
import {
  libraryLabelFor,
  unknownLibraries,
  type LibraryLookup,
} from "../../../core/flow/libraries.js";
import { flowsEqual } from "../../../core/flow/equal.js";
import { nodeWarnings } from "../../../core/flow/node-warnings.js";
import { defaultPermissionMode } from "../../../core/flow/choices.js";
import {
  bodyProblems,
  flowContainerName,
  flowContainerOf,
  flowIn,
  flowOut,
} from "../../../core/flow/structure.js";
import {
  NodeType,
  parseFlow,
  type CanvasNote,
  type Flow,
  type FlowContainer,
  type FlowSettings,
  type Node,
  type Wire,
} from "../../../core/flow/schema.js";
import { labelFor, nodeDefaults } from "../../../core/nodes/defaults.js";
import { nodeLook } from "../nodes/look.js";
import { noteLook } from "../nodes/note-look.js";
import {
  bodyOf,
  centerOf,
  containerAt,
  containerMoves,
  flowContainerAt,
  flowContainerBounds,
  FRAME_PADDING,
  followed,
  isContainer,
  widthOf,
  withPositions,
} from "./frames.js";
import {
  addConnection,
  addItems,
  addNode,
  addNote,
  addWire,
  deleteConnections,
  deleteFlowContainer,
  deleteNodes as deleteNodesCommand,
  deleteWires,
  moveNodes,
  updateFlowContainer as updateFlowContainerCommand,
  updateNode as updateNodeCommand,
  updateNote,
  updateSettings,
  type Command,
  type FlowContainerPatch,
  type Items,
  type Move,
} from "./commands.js";
import { tidyMoves } from "./layout.js";
import {
  connectionEdgeId,
  containerOfFrameId,
  edgeId,
  frameDragMoves,
  frameOwnerId,
} from "./view.js";

export const isNodeType = (value: string): value is NodeType => NodeType.safeParse(value).success;

export type FlowContainerKind = FlowContainer["kind"];

export type CanvasItemType = NodeType | FlowContainerKind | "note";

const isFlowContainerKind = (value: string): value is FlowContainerKind =>
  value === "workspace" || value === "session";

export const isCanvasItemType = (value: string): value is CanvasItemType =>
  value === "note" || isFlowContainerKind(value) || isNodeType(value);

export { nodeDefaults };

type WireEnd = { node: string; port: string };

type Position = { x: number; y: number };

type NoteBox = { x: number; y: number; width: number; height: number };

type NodeMenu = { nodeId: string; x: number; y: number };

type Focus = { node: string; seq: number };

type CanvasSize = { width: number; height: number };

export const defaultCanvasSize: CanvasSize = { width: 1600, height: 1000 };

export interface CanvasState {
  flow: Flow;
  libraries: LibraryLookup;
  librarySummaries: readonly FlowSummary[];
  openFlowId: string | null;
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
  clipboard: (Items & { opened: number }) | null;
  pastes: number;
  renaming: string | null;
  focus: Focus | null;
  opened: number;
  canvasSize: CanvasSize | null;
  fitSeq: number;
  drop(type: CanvasItemType, position: Position): void;
  addNext(type: CanvasItemType): void;
  setLibraries(summaries: readonly FlowSummary[], openFlowId: string | null): void;
  dropLibrary(flowId: string, position: Position): void;
  addLibrary(flowId: string): void;
  editNoteText(id: string, text: string): void;
  resizeNoteLive(id: string, box: NoteBox): void;
  resizeNote(id: string, box: NoteBox): void;
  connect(from: WireEnd, to: WireEnd): boolean;
  connectSessions(a: string, b: string): boolean;
  refuseConnection(): void;
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
  focusNode(id: string): void;
  openNodeMenu(nodeId: string, at: Position): void;
  closeNodeMenu(): void;
  highlight(id: string | null): void;
  dragTo(id: string, position: Position): void;
  endDrag(ids: readonly string[]): void;
  updateFlowContainer(id: string, patch: FlowContainerPatch): void;
  updateSettings(next: FlowSettings): void;
  updateNode(next: Node): void;
  applyAgent(command: Command): boolean;
  endAgentGroup(): void;
  setCanvasSize(size: CanvasSize): void;
  tidy(): Promise<void>;
  tidyFailed(error: unknown): void;
  foldIntoTop(expected: Command, snapshot: Flow, moves: Move[]): boolean;
  undo(): void;
  redo(): void;
  load(input: unknown): void;
  markSaved(flow: Flow): void;
}

export const nextNodeId = (type: NodeType, flow: Flow): string => {
  const used = new Set(flow.nodes.map((node) => node.id.toLowerCase()));
  let n = 1;
  while (used.has(`${type}-${n}`)) n += 1;
  return `${type}-${n}`;
};

const firstFree = (taken: ReadonlySet<string>, name: (n: number) => string): string => {
  let n = 1;
  while (taken.has(name(n))) n += 1;
  return name(n);
};

const newFlowContainer = (kind: FlowContainerKind, flow: Flow, nodes: string[]): FlowContainer => {
  const id = firstFree(
    new Set([...flow.nodes, ...flow.containers].map((item) => item.id.toLowerCase())),
    (n) => `${kind}-${n}`,
  );
  if (kind === "workspace") return { id, kind, model: "sonnet", nodes };
  const names = new Set(
    flow.containers.flatMap((container) => (container.kind === "session" ? [container.name] : [])),
  );
  const name = firstFree(names, (n) => (n === 1 ? "session" : `session-${n}`));
  return { id, kind, name, repo: "", branch: "", model: "sonnet", nodes };
};

const startToStop = 200;

const newStopSettings = { name: "result", type: "text" };

export const flowContainerItems = (
  kind: FlowContainerKind,
  flow: Flow,
  at: Position,
  nextId: (type: NodeType, flow: Flow) => string = nextNodeId,
): Items & { containers: FlowContainer[] } => {
  const start = newNode("trigger", nextId("trigger", flow), at);
  const withStart = { ...flow, nodes: [...flow.nodes, start] };
  const stop = {
    ...newNode("output", nextId("output", withStart), { x: at.x + startToStop, y: at.y }),
    settings: { ...newStopSettings },
  } as Node;
  return {
    nodes: [start, stop],
    wires: [
      { kind: "then", from: { node: start.id, port: "out" }, to: { node: stop.id, port: "in" } },
    ],
    notes: [],
    containers: [newFlowContainer(kind, flow, [start.id, stop.id])],
  };
};

const canvasLevel = (flow: Flow, type: "trigger" | "output") =>
  flow.nodes.filter(
    (node) =>
      node.type === type &&
      node.parent === undefined &&
      flowContainerOf(flow, node.id) === undefined,
  );

const canvasPathItems = (
  flow: Flow,
  workspace: string,
  at: Position,
  nextId: (type: NodeType, flow: Flow) => string,
): Items => {
  const starts = canvasLevel(flow, "trigger");
  const stops = canvasLevel(flow, "output");
  const added: Node[] = [];
  if (starts.length === 0) {
    added.push(newNode("trigger", nextId("trigger", flow), { x: at.x - startToStop, y: at.y }));
  }
  if (stops.length === 0) {
    const withStart = { ...flow, nodes: [...flow.nodes, ...added] };
    added.push({
      ...newNode("output", nextId("output", withStart), { x: at.x + 2 * startToStop, y: at.y }),
      settings: { ...newStopSettings },
    } as Node);
  }
  const ends = [...starts, ...stops, ...added];
  const from = ends.find(
    (node) => node.type === "trigger" && !flow.wires.some((wire) => wire.from.node === node.id),
  );
  const to = ends.find(
    (node) => node.type === "output" && !flow.wires.some((wire) => wire.to.node === node.id),
  );
  return {
    nodes: added,
    wires: [
      ...(from === undefined
        ? []
        : [
            {
              kind: "then",
              from: { node: from.id, port: "out" },
              to: { node: workspace, port: flowIn },
            },
          ]),
      ...(to === undefined
        ? []
        : [
            {
              kind: "then",
              from: { node: workspace, port: flowOut },
              to: { node: to.id, port: "in" },
            },
          ]),
    ] as Wire[],
    notes: [],
  };
};

const withCanvasPath = (
  flow: Flow,
  items: Items & { containers: FlowContainer[] },
  at: Position,
  nextId: (type: NodeType, flow: Flow) => string,
): Items & { containers: FlowContainer[] } => {
  const [workspace] = items.containers.filter(({ kind }) => kind === "workspace");
  if (workspace === undefined) return items;
  const path = canvasPathItems(withItems(flow, items), workspace.id, at, nextId);
  return {
    ...items,
    nodes: [...items.nodes, ...path.nodes],
    wires: [...items.wires, ...path.wires],
  };
};

const withItems = (flow: Flow, items: Items): Flow => addItems(items).do(flow);

const seedGap = 160;

export const newCanvasFlow = (): Flow => {
  const empty: Flow = {
    nodes: [],
    wires: [],
    containers: [],
    settings: { buildModel: "sonnet", permissionMode: defaultPermissionMode },
  };
  const at = { x: firstPosition.x + startToStop, y: firstPosition.y };
  const withWorkspace = withItems(empty, flowContainerItems("workspace", empty, at));
  const withSession = withItems(
    withWorkspace,
    flowContainerItems("session", withWorkspace, { x: at.x, y: at.y + seedGap }),
  );
  return withItems(withSession, canvasPathItems(withSession, "workspace-1", at, nextNodeId));
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

export const placeInContainer = (flow: Flow, type: NodeType, containerId: string): Position => {
  const members = new Set(flow.containers.find(({ id }) => id === containerId)?.nodes ?? []);
  const inside = topLevel(flow).filter((node) => members.has(node.id));
  const start = inside.find((node) => node.type === "trigger") ?? inside[0];
  if (start === undefined) return placeNode(flow, type, firstPosition);
  const right = flowContainerBounds(flow, containerId).right - FRAME_PADDING;
  return placeNode(flow, type, { x: right + gap, y: start.position.y });
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

const summaryLookup =
  (summaries: readonly FlowSummary[]): LibraryLookup =>
  (flowId) => {
    const summary = summaries.find((candidate) => candidate.flowId === flowId);
    return (
      summary && {
        name: summary.name,
        kind: summary.kind,
        sessions: summary.sessions,
        uses: summary.uses,
      }
    );
  };

type LibraryNode = Extract<Node, { type: "library" }>;

const isLibraryNode = (node: Node): node is LibraryNode => node.type === "library";

const byLibrariesAndFlow = <T>(compute: (flow: Flow, libraries: LibraryLookup) => T) => {
  const caches = new WeakMap<LibraryLookup, WeakMap<Flow, T>>();
  return (flow: Flow, libraries: LibraryLookup): T => {
    let byFlow = caches.get(libraries);
    if (byFlow === undefined) {
      byFlow = new WeakMap();
      caches.set(libraries, byFlow);
    }
    const cached = byFlow.get(flow);
    if (cached !== undefined) return cached;
    const computed = compute(flow, libraries);
    byFlow.set(flow, computed);
    return computed;
  };
};

const reasonOf = (flow: Flow, error: ValidationError) =>
  reasonNaming(error.node, error.message, labelIn(flow, error.node ?? ""));

export const nodeLabel = (nodes: readonly Node[], nodeId?: string): string => {
  if (nodeId === undefined) return labelFor(undefined);
  const node = nodes.find((candidate) => candidate.id === nodeId);
  return node ? labelFor(node) : nodeId;
};

const nodeIssues = byLibrariesAndFlow((flow, libraries) => {
  const issues: Record<string, string[]> = {};
  for (const error of flowProblems(flow, libraries)) {
    if (error.node !== undefined)
      (issues[error.node] ??= []).push(plainReason(error.node, error.message));
  }
  return issues;
});

export const selectNodeIssues = (
  flow: Flow,
  libraries: LibraryLookup = unknownLibraries,
): Record<string, string[]> => nodeIssues(flow, libraries);

const fieldIssues = byLibrariesAndFlow((flow, libraries) => {
  const byNode: Record<string, Record<string, string>> = {};
  for (const error of flowProblems(flow, libraries)) {
    if (error.node === undefined || error.field === undefined) continue;
    const fields = (byNode[error.node] ??= {});
    if (!(error.field in fields)) fields[error.field] = plainReason(error.node, error.message);
  }
  return byNode;
});

export const selectFieldIssues = (
  flow: Flow,
  nodeId: string,
  libraries: LibraryLookup = unknownLibraries,
): Record<string, string> => fieldIssues(flow, libraries)[nodeId] ?? {};

const warningsByNode = new WeakMap<Flow, Record<string, string[]>>();

const noWarnings: string[] = [];

export const selectNodeWarnings = (flow: Flow, nodeId: string): string[] => {
  let byNode = warningsByNode.get(flow);
  if (byNode === undefined) {
    byNode = Object.fromEntries(flow.nodes.map((node) => [node.id, nodeWarnings(node)]));
    warningsByNode.set(flow, byNode);
  }
  return byNode[nodeId] ?? noWarnings;
};

const containerIssues = byLibrariesAndFlow((flow, libraries) => {
  const byContainer: Record<string, Record<string, string>> = {};
  for (const { container, node, field, message } of flowProblems(flow, libraries)) {
    if (container === undefined || node !== undefined || field === undefined) continue;
    const fields = (byContainer[container] ??= {});
    if (!(field in fields)) fields[field] = message;
  }
  return byContainer;
});

export const selectFlowContainerIssues = (
  flow: Flow,
  containerId: string,
  libraries: LibraryLookup = unknownLibraries,
): Record<string, string> => containerIssues(flow, libraries)[containerId] ?? {};

export const selectSelectedNode = (state: Pick<CanvasState, "flow" | "selection">): Node | null => {
  const [id, ...more] = state.selection;
  if (id === undefined || more.length > 0) return null;
  return state.flow.nodes.find((node) => node.id === id) ?? null;
};

export const selectCanvasEmpty = (state: Pick<CanvasState, "flow">): boolean =>
  state.flow.nodes.length === 0 && (state.flow.notes ?? []).length === 0;

const sameEnd = (a: WireEnd, b: WireEnd) => a.node === b.node && a.port === b.port;

const sameWire = (a: Wire, b: Wire) => sameEnd(a.from, b.from) && sameEnd(a.to, b.to);

const cannotConnect = (flow: Flow, from: WireEnd, to: WireEnd, reason: string) =>
  `Can't connect ${labelIn(flow, from.node)} to ${labelIn(flow, to.node)}: ${reason}`;

const wrongWay =
  "Can't connect those ports: drag from a node's output on its right to another node's input on its left.";

const alreadyJoined = "they are already joined.";

const kept = (selection: readonly string[], flow: Flow) => {
  const ids = new Set(
    [...flow.nodes, ...(flow.notes ?? []), ...flow.containers].map(({ id }) => id),
  );
  return selection.filter((id) => ids.has(id));
};

const samePosition = (a: Position, b: Position) => a.x === b.x && a.y === b.y;

const noteIn = (flow: Flow, id: string) => flow.notes?.find((note) => note.id === id);

const positionOf = (flow: Flow, id: string) =>
  (flow.nodes.find((node) => node.id === id) ?? noteIn(flow, id))?.position;

export const selectCanDelete = (state: Pick<CanvasState, "selection" | "selectedWires">) =>
  state.selection.length > 0 || state.selectedWires.length > 0;

const keptWires = (selected: readonly string[], flow: Flow) => {
  const present = new Set([
    ...flow.wires.map(edgeId),
    ...(flow.connections ?? []).map(({ id }) => connectionEdgeId(id)),
  ]);
  return selected.filter((id) => present.has(id));
};

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

    const run = (command: Command, selection = get().selection) => {
      agentGroup = null;
      const { flow, undoStack } = get();
      record(command, command.do(flow), undoStack, selection);
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

    const connectionDeletion = (flow: Flow, edgeIds: readonly string[]): Command | undefined => {
      const doomed = new Set(edgeIds);
      const ids = (flow.connections ?? [])
        .filter(({ id }) => doomed.has(connectionEdgeId(id)))
        .map(({ id }) => id);
      return ids.length > 0 ? deleteConnections(flow, ids) : undefined;
    };

    const deletion = (
      flow: Flow,
      ids: readonly string[],
      edgeIds: readonly string[] = [],
    ): Command | undefined => {
      const containers = flow.containers.filter((container) => ids.includes(container.id));
      const steps = [
        ...containers.map(
          (container) => (current: Flow) => deleteFlowContainer(current, container.id),
        ),
        (current: Flow) => nodeDeletion(current, ids),
        (current: Flow) => wireDeletion(current, edgeIds),
        (current: Flow) => connectionDeletion(current, edgeIds),
      ];
      let current = flow;
      let command: Command | undefined;
      for (const step of steps) {
        const next = step(current);
        if (next === undefined) continue;
        current = next.do(current);
        command = command === undefined ? next : both(command, next);
      }
      return command;
    };

    const deleteNodes = (ids: readonly string[]) => {
      if (!ready()) return;
      set({ menu: null });
      const command = deletion(get().flow, ids);
      if (command !== undefined) run(command);
    };

    const deleteSelection = () => {
      if (!ready()) return;
      set({ menu: null });
      const { flow, selection, selectedWires } = get();
      const command = deletion(flow, selection, selectedWires);
      if (command !== undefined) run(command);
    };

    const refusal = (others: readonly Wire[], wire: Wire, command: Command): string | null => {
      const { flow } = get();
      if (others.some((existing) => sameWire(existing, wire))) {
        return cannotConnect(flow, wire.from, wire.to, alreadyJoined);
      }
      const after = command.do(flow);
      const ownsSection = (id: string | undefined) => {
        const type = after.nodes.find((node) => node.id === id)?.type;
        return type === "fork" || type === "join";
      };
      const [error] = newProblems(flow, after, get().libraries).filter(
        (candidate) => !(candidate.rule === "parallel-section" && ownsSection(candidate.node)),
      );
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
      const members = Object.fromEntries(
        nodes.flatMap((node) => {
          if (node.parent !== undefined) return [];
          const container = flow.containers.find(({ nodes: ids }) => ids.includes(node.id));
          return container === undefined ? [] : [[node.id, container.id]];
        }),
      );
      return structuredClone({ nodes, wires, notes, members });
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
      const sourceOf = new Map([...renamed].map(([source, id]) => [id, source]));
      const containerOf = (node: Node): string | undefined => {
        const recorded = items.members?.[sourceOf.get(node.id) ?? ""];
        return (
          flowContainerAt(flow, centerOf(node)) ??
          flow.containers.find((container) => container.id === recorded)?.id
        );
      };
      const members = Object.fromEntries(
        nodes.flatMap((node) => {
          const container = node.parent === undefined ? containerOf(node) : undefined;
          return container === undefined ? [] : [[node.id, container]];
        }),
      );
      return { nodes, wires, notes, members };
    };

    const pasteItems = (items: Items, offset: Position): boolean => {
      const { flow, libraries, openFlowId } = get();
      const [loop] = items.nodes.filter(isLibraryNode).flatMap(({ settings: { libraryId } }) => {
        const reason = loopRefusal(libraries, openFlowId, libraryId);
        return reason === undefined
          ? []
          : [`${libraries(libraryId)?.name ?? "library"}: ${reason}`];
      });
      if (loop !== undefined) {
        set({ message: `Can't paste ${loop}` });
        return false;
      }
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
          target !== null && isContainer(target) ? ` into ${labelIn(after, target.id)}` : "";
        const reason = reasonNaming(
          misplaced.node,
          `${misplaced.message}.`,
          labelIn(after, misplaced.node),
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

    const dropFlowContainer = (kind: FlowContainerKind, position: Position) => {
      const { flow } = get();
      const label = kind === "workspace" ? "Workspace" : "Session";
      const inside = flowContainerAt(flow, position) ?? containerAt(flow, position);
      if (inside !== undefined) {
        const host = flow.containers.find((container) => container.id === inside);
        const where = host === undefined ? labelIn(flow, inside) : flowContainerName(host);
        set({
          message: `Can't drop ${label} into ${where}: a ${label} sits on the canvas, never inside another container.`,
        });
        return;
      }
      const items = withCanvasPath(
        flow,
        flowContainerItems(kind, flow, position, nextId),
        position,
        nextId,
      );
      run(
        addItems(items),
        items.containers.map(({ id }) => id),
      );
    };

    const dropLibrary = (flowId: string, position: Position) => {
      const { flow, libraries, openFlowId } = get();
      const name = libraries(flowId)?.name ?? "library";
      const label = libraryLabelFor(flow, name);
      const id = nextId("library", flow);
      const parent = containerAt(flow, position);
      const at = placeNode(flow, "library", position, parent);
      const member = parent === undefined ? flowContainerAt(flow, position) : undefined;
      const node: LibraryNode = {
        id,
        type: "library",
        label,
        position: at,
        ...(parent === undefined ? {} : { parent }),
        settings: { libraryId: flowId, label, overrides: {} },
      };
      const host = member ?? parent;
      const into = host === undefined ? "" : ` into ${labelIn(flow, host)}`;
      const command = addNode(node, member);
      const refused = libraryRefusal({
        before: flow,
        after: command.do(flow),
        nodeId: id,
        libraryId: flowId,
        libraries,
        openFlowId,
      });
      if (refused !== undefined) {
        set({ message: `Can't drop ${name}${into}: ${refused}` });
        return;
      }
      run(command, [id]);
    };

    const start = newCanvasFlow();

    return {
      flow: start,
      libraries: unknownLibraries,
      librarySummaries: [],
      openFlowId: null,
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
      clipboard: null,
      pastes: 0,
      renaming: null,
      focus: null,
      opened: 0,
      canvasSize: null,
      fitSeq: 0,

      drop: (type, position) => {
        if (!ready()) return;
        const { flow } = get();
        if (type === "note") {
          const id = nextNoteId(flow);
          run(addNote(newNote(id, position)), [id]);
          return;
        }
        if (isFlowContainerKind(type)) {
          dropFlowContainer(type, position);
          return;
        }
        const id = nextId(type, flow);
        const parent = isContainer({ type }) ? undefined : containerAt(flow, position);
        const at = placeNode(flow, type, position, parent);
        const member = parent === undefined ? flowContainerAt(flow, position) : undefined;
        const command = addNode(newNode(type, id, at, parent), member);
        const [misplaced] = newProblems(flow, command.do(flow), get().libraries).filter(
          (error) => error.rule === "body-nodes",
        );
        if (misplaced !== undefined) {
          set({
            message: `Can't drop ${nodeDefaults[type].label} into ${labelIn(flow, parent ?? "")}: ${reasonOf(command.do(flow), misplaced)}`,
          });
          return;
        }
        run(command, [id]);
      },

      addNext: (type) => get().drop(type, nextTo(get().flow, get().selection)),

      setLibraries: (summaries, openFlowId) =>
        set({ libraries: summaryLookup(summaries), librarySummaries: summaries, openFlowId }),

      dropLibrary: (flowId, position) => {
        if (ready()) dropLibrary(flowId, position);
      },

      addLibrary: (flowId) => get().dropLibrary(flowId, nextTo(get().flow, get().selection)),

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
        return addChecked({ kind: "then", from: { ...from }, to: { ...to } });
      },

      connectSessions: (a, b) => {
        if (!ready()) return false;
        const { flow } = get();
        const refused = connectionRefusal(flow, [a, b], get().libraries);
        if (refused !== undefined) {
          set({ message: refused });
          return false;
        }
        run(addConnection({ id: nextConnectionId(flow), between: [a, b] }));
        return true;
      },

      refuseConnection: () => {
        if (ready()) set({ message: wrongWay });
      },

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
        if (items !== null) set({ clipboard: { ...items, opened: get().opened }, pastes: 0 });
      },

      paste: () => {
        const { clipboard, pastes, opened } = get();
        if (!ready() || clipboard === null) return;
        const items = clipboard.opened === opened ? clipboard : { ...clipboard, members: {} };
        const step = (pastes + 1) * pasteGap;
        if (pasteItems(items, { x: step, y: step })) set({ pastes: pastes + 1 });
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

      focusNode: (id) => {
        set({
          selection: [id],
          selectedWires: [],
          menu: null,
          focus: { node: id, seq: (get().focus?.seq ?? 0) + 1 },
        });
      },

      openNodeMenu: (nodeId, { x, y }) =>
        set({ menu: { nodeId: frameOwnerId(nodeId) ?? nodeId, x, y } }),

      closeNodeMenu: () => set({ menu: null }),

      highlight: (id) => set({ highlighted: id }),

      dragTo: (id, { x, y }) => {
        if (!ready()) return;
        set(({ dragPositions }) => ({ dragPositions: { ...dragPositions, [id]: { x, y } } }));
      },

      endDrag: (ids) => {
        if (!ready()) return;
        const { flow, dragPositions } = get();
        const draggedOf = (frames: boolean) =>
          Object.fromEntries(
            ids.flatMap((id) => {
              const position = dragPositions[id];
              const isFrame = containerOfFrameId(id) !== undefined;
              return position === undefined || isFrame !== frames ? [] : [[id, position] as const];
            }),
          );
        const dragged = draggedOf(false);
        const carried = frameDragMoves(flow, draggedOf(true));
        const targets = { ...carried, ...followed(flow, dragged) };
        const framing = withPositions(flow, { ...carried, ...containerMoves(flow, dragged) });
        const moved = withPositions(flow, targets);
        const parentOf = (node: Node): Move["parent"] => {
          if (isContainer(node) || !(node.id in dragged)) return undefined;
          if (node.parent !== undefined && node.parent in dragged) return undefined;
          const to = containerAt(framing, centerOf(node));
          return to === node.parent ? undefined : { from: node.parent, to };
        };
        const carriedWhole = (container: FlowContainer) =>
          container.nodes.every((id) => id in dragged);
        const membershipOf = (node: Node, parent: Move["parent"]): Move["container"] => {
          if (!(node.id in dragged)) return undefined;
          const home = flow.containers.find((container) => container.nodes.includes(node.id));
          const nested = parent === undefined ? node.parent : parent.to;
          const to = nested === undefined ? flowContainerAt(flow, centerOf(node)) : undefined;
          const frameFollows = home !== undefined && nested === undefined && carriedWhole(home);
          if (to === home?.id || (frameFollows && to === undefined)) return undefined;
          return { from: home?.id, to };
        };
        const moves = Object.entries(targets).flatMap(([id, to]): Move[] => {
          const from = positionOf(flow, id);
          const node = moved.nodes.find((candidate) => candidate.id === id);
          const parent = node === undefined ? undefined : parentOf(node);
          const container = node === undefined ? undefined : membershipOf(node, parent);
          const unchanged = parent === undefined && container === undefined;
          if (from === undefined || (samePosition(from, to) && unchanged)) return [];
          return [
            {
              id,
              from,
              to,
              ...(parent === undefined ? {} : { parent }),
              ...(container === undefined ? {} : { container }),
            },
          ];
        });
        set({ dragPositions: {} });
        if (moves.length === 0) return;
        const command = moveNodes(moves);
        const nested = moves.find((move) => move.parent !== undefined);
        if (nested?.parent !== undefined) {
          const [error] = newProblems(flow, command.do(flow), get().libraries).filter(
            (candidate) => candidate.rule !== "loop-body",
          );
          if (error !== undefined) {
            const { from, to } = nested.parent;
            const where = to === undefined ? `out of ${from ?? ""}` : `into ${to}`;
            set({
              message: `Can't move ${labelIn(flow, nested.id)} ${where}: ${reasonOf(command.do(flow), error)}`,
            });
            return;
          }
        }
        run(command);
      },

      updateFlowContainer: (id, patch) => {
        if (ready()) run(updateFlowContainerCommand(id, patch));
      },

      updateSettings: (next) => {
        if (ready()) run(updateSettings(next));
      },

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

      setCanvasSize: (size) => set({ canvasSize: size }),

      tidy: async () => {
        if (!ready()) return;
        const { flow, canvasSize } = get();
        let moves: Move[];
        try {
          moves = await tidyMoves(flow, canvasSize ?? defaultCanvasSize);
        } catch (error) {
          get().tidyFailed(error);
          return;
        }
        if (get().flow !== flow || moves.length === 0) return;
        run(moveNodes(moves));
        set({ fitSeq: get().fitSeq + 1 });
      },

      tidyFailed: (error) => {
        console.error("Tidy layout failed", error);
        set({
          message: `Can't tidy the layout: ${error instanceof Error ? error.message : String(error)}`,
        });
      },

      foldIntoTop: (expected, snapshot, moves) => {
        const { flow, undoStack } = get();
        if (undoStack.at(-1) !== expected || flow !== snapshot) return false;
        const tidied = moveNodes(moves);
        record(both(expected, tidied), tidied.do(flow), undoStack.slice(0, -1));
        set({ fitSeq: get().fitSeq + 1 });
        return true;
      },

      undo: () => {
        if (!ready()) return;
        agentGroup = null;
        const { flow, undoStack, redoStack, selection } = get();
        const command = undoStack.at(-1);
        if (command === undefined) return;
        const next = command.undo(flow);
        set({
          flow: next,
          undoStack: undoStack.slice(0, -1),
          redoStack: [...redoStack, command],
          selection: kept(selection, next),
          selectedWires: keptWires(get().selectedWires, next),
        });
      },

      redo: () => {
        if (!ready()) return;
        agentGroup = null;
        const { flow, undoStack, redoStack, selection } = get();
        const command = redoStack.at(-1);
        if (command === undefined) return;
        const next = command.do(flow);
        set({
          flow: next,
          undoStack: [...undoStack, command],
          redoStack: redoStack.slice(0, -1),
          selection: kept(selection, next),
          selectedWires: keptWires(get().selectedWires, next),
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
