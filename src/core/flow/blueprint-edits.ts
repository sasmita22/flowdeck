import { z } from "zod";
import { flowProblems } from "../compiler/flow-problems.js";
import { validate, type ValidationError } from "../compiler/validate.js";
import { rule as containerWiresRule } from "../compiler/rules/container-wires.js";
import { rule as portsRule } from "../compiler/rules/ports.js";
import { nodeDefaults } from "../nodes/defaults.js";
import { registry } from "../nodes/registry.js";
import { toolInputs, type ToolName } from "./blueprint-tools.js";
import { libraryLabelFor, unknownLibraries, type LibraryLookup } from "./libraries.js";
import { Wire, type Flow, type NodeType } from "./schema.js";

type Settings = Record<string, unknown>;

export type BlueprintEdit =
  | { tool: "add_node"; type: NodeType; label: string; parent?: string; settings: Settings }
  | { tool: "change_node"; nodeId: string; label?: string; settings?: Settings }
  | { tool: "wire"; wire: Wire }
  | { tool: "delete_node"; nodeId: string }
  | { tool: "tidy_layout" }
  | { tool: "add_connection"; between: [string, string] }
  | { tool: "delete_connection"; connectionId: string };

export type EditCheck = { ok: true; edit: BlueprintEdit } | { ok: false; reason: string };

const refuse = (reason: string): EditCheck => ({ ok: false, reason });

const parsed = <T>(schema: z.ZodType<T>, input: unknown): T | string => {
  const result = schema.safeParse(input);
  return result.success ? result.data : z.prettifyError(result.error);
};

const settingsFor = (type: NodeType, settings: Settings): Settings | string =>
  parsed(registry[type].settings as z.ZodType<Settings>, settings);

const isEditTool = (name: string): name is ToolName & BlueprintEdit["tool"] =>
  [
    "add_node",
    "change_node",
    "wire",
    "delete_node",
    "tidy_layout",
    "add_connection",
    "delete_connection",
  ].includes(name);

const sessionLabel = (flow: Flow, id: string) => {
  const container = flow.containers.find((candidate) => candidate.id === id);
  return container?.kind === "session" ? container.name : id;
};

const alreadyConnected = (flow: Flow, [a, b]: readonly [string, string]) =>
  `${sessionLabel(flow, a)} and ${sessionLabel(flow, b)} are already connected.`;

const selfConnection = "A session cannot connect to itself.";

const connectionJoining = (flow: Flow, a: string, b: string) =>
  flow.connections?.find(({ between }) => between.includes(a) && between.includes(b));

export const nextConnectionId = (flow: Flow): string => {
  const used = new Set((flow.connections ?? []).map(({ id }) => id));
  let n = 1;
  while (used.has(`c${n}`)) n += 1;
  return `c${n}`;
};

export function connectionRefusal(
  flow: Flow,
  between: [string, string],
  libraries?: LibraryLookup,
): string | undefined {
  const [a, b] = between;
  if (a === b) return selfConnection;
  const existing = connectionJoining(flow, a, b);
  if (existing !== undefined) return alreadyConnected(flow, existing.between);
  const after: Flow = {
    ...flow,
    connections: [...(flow.connections ?? []), { id: nextConnectionId(flow), between }],
  };
  const [problem] = newProblems(flow, after, libraries).filter(
    ({ rule }) => rule === "session-connections",
  );
  return problem?.message;
}

export function checkEdit(
  flow: Flow,
  name: string,
  input: unknown,
  libraries: LibraryLookup = unknownLibraries,
): EditCheck {
  if (!isEditTool(name)) return refuse(`"${name}" is not a blueprint edit.`);
  const nodeOf = (id: string) => flow.nodes.find((node) => node.id === id);
  const missing = (id: string) => refuse(`No node "${id}" in the blueprint.`);
  const libraryLabel = (libraryId: unknown, exceptNodeId?: string) =>
    libraryLabelFor(flow, libraries(String(libraryId))?.name ?? "library", exceptNodeId);

  switch (name) {
    case "add_node": {
      const data = parsed(toolInputs.add_node, input);
      if (typeof data === "string") return refuse(data);
      const settings = settingsFor(data.type, {
        ...nodeDefaults[data.type].settings,
        ...data.settings,
      });
      if (typeof settings === "string") return refuse(settings);
      const label = data.type === "library" ? libraryLabel(settings.libraryId) : data.label;
      return {
        ok: true,
        edit: {
          tool: name,
          type: data.type,
          label,
          settings: data.type === "library" ? { ...settings, label } : settings,
          ...(data.parent === undefined ? {} : { parent: data.parent }),
        },
      };
    }
    case "change_node": {
      const data = parsed(toolInputs.change_node, input);
      if (typeof data === "string") return refuse(data);
      const node = nodeOf(data.nodeId);
      if (node === undefined) return missing(data.nodeId);
      const settings =
        data.settings === undefined
          ? undefined
          : settingsFor(node.type, { ...node.settings, ...data.settings });
      if (typeof settings === "string") return refuse(settings);
      if (
        node.type === "library" &&
        settings !== undefined &&
        settings.libraryId !== node.settings.libraryId
      ) {
        const label = libraryLabel(settings.libraryId, node.id);
        const overrides = data.settings?.overrides === undefined ? {} : settings.overrides;
        return {
          ok: true,
          edit: {
            tool: name,
            nodeId: data.nodeId,
            label,
            settings: { ...settings, label, overrides },
          },
        };
      }
      return {
        ok: true,
        edit: {
          tool: name,
          nodeId: data.nodeId,
          ...(data.label === undefined ? {} : { label: data.label }),
          ...(settings === undefined ? {} : { settings }),
        },
      };
    }
    case "wire": {
      const data = parsed(toolInputs.wire, input);
      if (typeof data === "string") return refuse(data);
      const wire = parsed(Wire, data);
      if (typeof wire === "string") return refuse(wire);
      const absent = [wire.from.node, wire.to.node].find((id) => nodeOf(id) === undefined);
      if (absent !== undefined) return missing(absent);
      const [portError] = portsRule.check({ ...flow, wires: [wire] });
      if (portError !== undefined) return refuse(portError.message);
      const [crossing] = containerWiresRule.check({ ...flow, wires: [wire] });
      if (crossing !== undefined) return refuse(crossing.message);
      return { ok: true, edit: { tool: name, wire } };
    }
    case "delete_node": {
      const data = parsed(toolInputs.delete_node, input);
      if (typeof data === "string") return refuse(data);
      if (nodeOf(data.nodeId) === undefined) return missing(data.nodeId);
      return { ok: true, edit: { tool: name, nodeId: data.nodeId } };
    }
    case "tidy_layout": {
      const data = parsed(toolInputs.tidy_layout, input);
      if (typeof data === "string") return refuse(data);
      return { ok: true, edit: { tool: name } };
    }
    case "add_connection": {
      const data = parsed(toolInputs.add_connection, input);
      if (typeof data === "string") return refuse(data);
      const refusal = connectionRefusal(flow, data.between, libraries);
      if (refusal !== undefined) return refuse(refusal);
      return { ok: true, edit: { tool: name, between: data.between } };
    }
    case "delete_connection": {
      const data = parsed(toolInputs.delete_connection, input);
      if (typeof data === "string") return refuse(data);
      if (!(flow.connections ?? []).some(({ id }) => id === data.connectionId)) {
        return refuse(`No connection "${data.connectionId}" in the blueprint.`);
      }
      return { ok: true, edit: { tool: name, connectionId: data.connectionId } };
    }
  }
}

const problemKey = (flow: Flow, error: ValidationError) => {
  const wire = error.wire === undefined ? undefined : flow.wires[error.wire];
  const ends = wire && [wire.from.node, wire.from.port, wire.to.node, wire.to.port];
  return JSON.stringify([error.rule, error.node, error.field, ends]);
};

export function newProblems(
  before: Flow,
  after: Flow,
  libraries?: LibraryLookup,
): ValidationError[] {
  const known = new Set(
    [
      ...validate(before, libraries).filter((error) => error.field !== undefined),
      ...flowProblems(before, libraries),
    ].map((error) => problemKey(before, error)),
  );
  return flowProblems(after, libraries).filter((error) => !known.has(problemKey(after, error)));
}

export function editProblems(
  before: Flow,
  after: Flow,
  nodeIds: readonly string[],
  libraries?: LibraryLookup,
): ValidationError[] {
  const onMainFlow = newProblems(before, after, libraries);
  const known = new Set([
    ...validate(before, libraries).map((error) => problemKey(before, error)),
    ...onMainFlow.map((error) => problemKey(after, error)),
  ]);
  const onTouched = validate(after, libraries).filter(
    (error) =>
      error.node !== undefined &&
      nodeIds.includes(error.node) &&
      !known.has(problemKey(after, error)),
  );
  return [...onMainFlow, ...onTouched];
}
