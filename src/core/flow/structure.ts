import type { BuildConfig, Flow, FlowContainer, Node } from "./schema.js";

type StructureNode = Pick<Node, "id" | "type" | "parent">;

export function firstTurnId(body: readonly Pick<Node, "id" | "type">[]): string | undefined {
  return body.find((node) => node.type === "agent")?.id;
}

type BodyProblem = {
  node: string;
  message: string;
  parentMissing?: true;
  outOfPlace?: true;
  nested?: true;
};

const isContainer = (node: StructureNode) => node.type === "loop";

const flowEnd = (node: StructureNode) => node.type === "trigger" || node.type === "output";

export function bodyProblems(nodes: readonly StructureNode[]): BodyProblem[] {
  const ids = new Set(nodes.map((node) => node.id));
  const containers = new Map(nodes.filter(isContainer).map((node) => [node.id, node.type]));
  return nodes.flatMap((node) => {
    const problems: BodyProblem[] = [];
    const parentType = node.parent === undefined ? undefined : containers.get(node.parent);
    const named = `${node.id} (${node.type})`;
    if (isContainer(node)) {
      const body = nodes.filter((child) => child.parent === node.id);
      if (firstTurnId(body) === undefined) {
        problems.push({ node: node.id, message: `${named} has no agent in its body` });
      }
      if (parentType !== undefined) {
        problems.push({
          node: node.id,
          message: `${named} is inside ${parentType} ${node.parent}`,
          nested: true,
        });
      }
    }
    if (flowEnd(node) && parentType !== undefined) {
      problems.push({
        node: node.id,
        message: `${named} cannot be inside ${parentType} ${node.parent}`,
        outOfPlace: true,
      });
    }
    if (node.parent !== undefined && parentType === undefined) {
      problems.push({
        node: node.id,
        message: `${named} has parent ${node.parent}, which is not a loop`,
        ...(ids.has(node.parent) ? {} : { parentMissing: true as const }),
      });
    }
    return problems;
  });
}

export const flowIn = "flow-in";

export const flowOut = "flow-out";

export function flowContainerOf(flow: Flow, nodeId: string): FlowContainer | undefined {
  const listing = flow.containers.find((container) => container.nodes.includes(nodeId));
  if (listing !== undefined) return listing;
  const parent = flow.nodes.find((node) => node.id === nodeId)?.parent;
  return parent === undefined ? undefined : flowContainerOf(flow, parent);
}

export function flowContainerMembers(flow: Flow, containerId: string): string[] {
  const direct = flow.containers.find((container) => container.id === containerId)?.nodes ?? [];
  const withBodies = (ids: readonly string[]): string[] =>
    ids.flatMap((id) => [
      id,
      ...withBodies(flow.nodes.filter((node) => node.parent === id).map((node) => node.id)),
    ]);
  return withBodies(direct);
}

export const isWorkflow = (flow: Flow): boolean =>
  flow.containers.some((container) => container.kind === "workspace");

export const libraryBuildReason =
  "A library cannot be built: add a workspace to make it a workflow.";

export function flowContainerNodesOfType(
  flow: Flow,
  container: FlowContainer,
  type: Node["type"],
): string[] {
  const types = new Map(flow.nodes.map((node) => [node.id, node.type]));
  return flowContainerMembers(flow, container.id).filter((id) => types.get(id) === type);
}

export const flowContainerName = (container: FlowContainer): string =>
  container.kind === "workspace" ? "The workspace" : `Session "${container.name}"`;

export function sessionBuildConfig(flow: Flow): BuildConfig | undefined {
  const session = flow.containers.find((container) => container.kind === "session");
  if (session === undefined) return undefined;
  return {
    ...(session.repo === "" ? {} : { repo: session.repo }),
    ...(session.branch === "" ? {} : { base: session.branch }),
  };
}
