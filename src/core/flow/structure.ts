import { firstTurnId } from "../nodes/foreach/execute.js";
import type { Node } from "./schema.js";

type StructureNode = Pick<Node, "id" | "type" | "parent">;

export type BodyProblem = {
  node: string;
  message: string;
  parentMissing?: true;
  outOfPlace?: true;
};

const isContainer = (node: StructureNode) => node.type === "loop" || node.type === "foreach";

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
        problems.push({ node: node.id, message: `${named} has no prompt or agent in its body` });
      }
      if (parentType !== undefined) {
        problems.push({
          node: node.id,
          message: `${named} is inside ${parentType} ${node.parent}`,
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
        message: `${named} has parent ${node.parent}, which is not a loop or foreach`,
        ...(ids.has(node.parent) ? {} : { parentMissing: true as const }),
      });
    }
    return problems;
  });
}
