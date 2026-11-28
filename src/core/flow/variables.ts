import { z } from "zod";
import { labelOf } from "./labels.js";
import type { LibraryLookup } from "./libraries.js";
import { mainFlowOnly } from "./main-flow.js";
import { coveredOnEveryPath, reachableFrom } from "./paths.js";
import type { Flow, Node } from "./schema.js";

export type VariableValues = Readonly<Record<string, string | boolean>>;

export const safeName = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const reference = /\{\{\s*([^{}]*?)\s*\}\}/g;

export const isVariableName = (name: string): boolean =>
  name.split(".").every((segment) => safeName.test(segment));

export const referencedVariables = (text: string): string[] => [
  ...new Set(Array.from(text.matchAll(reference), ([, name]) => name ?? "")),
];

export const fillVariables = (text: string, values: VariableValues): string =>
  text.replace(reference, (whole, name: string) => {
    const value = values[name];
    return value === undefined ? whole : String(value);
  });

export const FoundVariable = z.object({
  name: z.string(),
  kind: z.enum(["yes-no", "text"]),
  nodeIds: z.tuple([z.string()]).rest(z.string()),
  group: z.object({ path: z.string(), name: z.string() }).optional(),
});

export type FoundVariable = z.infer<typeof FoundVariable>;

export type LibraryUse = {
  path: string;
  name: string;
  kind: "node-library" | "session-library";
};

export const groupVariables = (
  found: readonly FoundVariable[],
  uses: readonly LibraryUse[],
): FoundVariable[] =>
  found.map((variable) => {
    const owner = uses
      .filter(({ path }) => variable.name.startsWith(`${path}.`))
      .reduce<LibraryUse | undefined>(
        (longest, use) => (longest && longest.path.length >= use.path.length ? longest : use),
        undefined,
      );
    return owner ? { ...variable, group: { path: owner.path, name: owner.name } } : variable;
  });

type NodeIds = FoundVariable["nodeIds"];

const collect = (entries: readonly (readonly [string, string])[]): Map<string, NodeIds> => {
  const found = new Map<string, NodeIds>();
  for (const [name, nodeId] of entries) {
    const ids = found.get(name);
    if (ids === undefined) found.set(name, [nodeId]);
    else if (!ids.includes(nodeId)) ids.push(nodeId);
  }
  return found;
};

const claimedBy = (node: Node, lookup: LibraryLookup): readonly string[] => {
  if (node.type === "branch") return node.settings.variable === "" ? [] : [node.settings.variable];
  if (node.type === "library") return lookup(node.settings.libraryId)?.sends ?? [];
  return [];
};

const variableClaims = (flow: Flow, lookup: LibraryLookup): Map<string, NodeIds> =>
  collect(
    flow.nodes.flatMap((node) => claimedBy(node, lookup).map((name) => [name, node.id] as const)),
  );

const textUses = (flow: Flow): Map<string, NodeIds> =>
  collect(
    flow.nodes.flatMap((node) =>
      node.type === "agent"
        ? referencedVariables(node.settings.instructions).map((name) => [name, node.id] as const)
        : [],
    ),
  );

const byName = (variables: FoundVariable[]): FoundVariable[] =>
  variables.sort((a, b) => a.name.localeCompare(b.name));

const asFound = (uses: Map<string, NodeIds>, kind: FoundVariable["kind"]): FoundVariable[] =>
  [...uses].map(([name, nodeIds]) => ({ name, kind, nodeIds }));

export function foundVariables(flow: Flow): FoundVariable[] {
  const main = mainFlowOnly(flow);
  return byName([
    ...asFound(
      variableClaims(main, () => undefined),
      "yes-no",
    ),
    ...asFound(textUses(main), "text"),
  ]);
}

export const producedNames = (node: Node): string[] =>
  node.type === "agent"
    ? (node.settings.produces ?? []).map(({ variable }) => variable).filter((name) => name !== "")
    : [];

const producersBefore = (
  flow: Flow,
  name: string,
  claimants: readonly string[],
): string[] | undefined => {
  const producers = flow.nodes
    .filter((node) => producedNames(node).includes(name))
    .map((node) => node.id);
  if (producers.length === 0) return undefined;
  if (!claimants.every((claimant) => coveredOnEveryPath(flow, claimant, producers))) {
    return undefined;
  }
  const before = producers.filter((producer) => {
    const later = reachableFrom(flow, producer);
    return claimants.some((claimant) => later.has(claimant));
  });
  return before.length === 0 ? undefined : before;
};

export type OwnedVariable = { name: string; definedBy?: string[] };

export type BlueprintVariables = {
  owned: OwnedVariable[];
  sends: string[];
  toAsk: FoundVariable[];
};

export function blueprintVariables(flow: Flow, lookup: LibraryLookup): BlueprintVariables {
  const main = mainFlowOnly(flow, lookup);
  const claims = variableClaims(main, lookup);
  const owned = [...claims].map(([name, claimants]): OwnedVariable => {
    const producers = producersBefore(main, name, claimants);
    return producers === undefined
      ? { name }
      : { name, definedBy: producers.map((id) => labelOf(main, id)) };
  });
  const sends = owned.filter(({ definedBy }) => definedBy === undefined).map(({ name }) => name);
  const undefinedClaims = new Map([...claims].filter(([name]) => sends.includes(name)));
  return {
    owned,
    sends,
    toAsk: byName([...asFound(undefinedClaims, "yes-no"), ...asFound(textUses(main), "text")]),
  };
}
