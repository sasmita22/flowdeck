import type { Node, Wire } from "../../flow/schema.js";
import { agentType } from "../agent/execute.js";

export type ParallelSection = { fork: string; join: string; branches: string[] };

export type SectionProblem = { node: string; message: string };

export type ParallelSections = { sections: ParallelSection[]; problems: SectionProblem[] };

export type SectionNode = Pick<Node, "id" | "type" | "parent">;

export function parallelSections(
  nodes: readonly SectionNode[],
  wires: readonly Wire[],
): ParallelSections {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const thenWires = wires.filter((wire) => wire.kind === "then");
  const outOf = (id: string) =>
    thenWires.filter((wire) => wire.from.node === id).map((wire) => wire.to.node);
  const into = (id: string) =>
    thenWires.filter((wire) => wire.to.node === id).map((wire) => wire.from.node);
  const sections: ParallelSection[] = [];
  const problems: SectionProblem[] = [];
  const branchesInto = new Map<string, Set<string>>();
  const forksInto = new Map<string, Set<string>>();

  for (const node of nodes) {
    if ((node.type === "fork" || node.type === "join") && node.parent !== undefined) {
      problems.push({ node: node.id, message: "sits inside a loop; parallel sections cannot." });
    }
  }

  for (const fork of nodes.filter((node) => node.type === "fork")) {
    const branches = [...new Set(outOf(fork.id))];
    const joins = new Set<string>();
    let sound = fork.parent === undefined;
    let intoNoJoin = false;
    if (branches.length < 2) {
      problems.push({
        node: fork.id,
        message: `has ${branches.length} branches; a parallel start needs two or more.`,
      });
      sound = false;
    }
    for (const branch of branches) {
      const node = byId.get(branch);
      if (node?.type !== "agent") {
        problems.push({ node: branch, message: "is a parallel branch that is not an Agent." });
        sound = false;
        continue;
      }
      if (node.parent !== undefined) {
        problems.push({ node: branch, message: "sits inside a loop; parallel sections cannot." });
        sound = false;
        continue;
      }
      const outs = outOf(branch);
      if (into(branch).length > 1 || outs.length > 1) {
        problems.push({
          node: branch,
          message: "is a parallel branch with more than one wire in or out.",
        });
        sound = false;
        continue;
      }
      const target = outs[0];
      if (target === undefined || byId.get(target)?.type !== "join") {
        intoNoJoin = true;
        continue;
      }
      joins.add(target);
      const reaching = branchesInto.get(target) ?? new Set<string>();
      for (const sibling of branches) reaching.add(sibling);
      branchesInto.set(target, reaching);
      forksInto.set(target, (forksInto.get(target) ?? new Set<string>()).add(fork.id));
    }
    if (intoNoJoin) {
      problems.push({ node: fork.id, message: "has a branch that leads into no parallel end." });
      sound = false;
    } else if (joins.size > 1) {
      problems.push({
        node: fork.id,
        message: "has branches that lead into different parallel ends.",
      });
      sound = false;
    }
    const [join] = joins;
    if (sound && join !== undefined) sections.push({ fork: fork.id, join, branches });
  }

  const sharedJoins = new Set<string>();
  for (const join of nodes.filter((node) => node.type === "join")) {
    const branches = branchesInto.get(join.id);
    if ((forksInto.get(join.id)?.size ?? 0) > 1) {
      sharedJoins.add(join.id);
      problems.push({
        node: join.id,
        message: "is a parallel end reached from more than one parallel start.",
      });
    } else if (branches === undefined) {
      problems.push({
        node: join.id,
        message: "is a parallel end that no parallel start reaches.",
      });
    } else if (into(join.id).some((source) => !branches.has(source))) {
      problems.push({
        node: join.id,
        message: "is a parallel end wired from a node that is not a branch of its start.",
      });
    }
  }

  return {
    sections: sections.filter((section) => !sharedJoins.has(section.join)),
    problems,
  };
}

export function forkTurnText(hash: string, branches: readonly string[]): string {
  const types = branches.map((branch) => `"${agentType(hash, branch)}"`).join(", ");
  return `Use the Agent tool once for each of these subagent_types, each with the prompt "Go": ${types}. Make all the Agent calls in one message, and do not wait for one agent to finish before starting the next.`;
}

export function unlaunched(
  branchTypes: readonly string[],
  launchedTypes: readonly string[],
): string[] {
  return branchTypes.filter((type) => !launchedTypes.includes(type));
}
