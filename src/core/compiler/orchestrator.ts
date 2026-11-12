import { handoffFolderLine } from "../flow/handoff.js";
import type { Wire } from "../flow/schema.js";
import { agentPrompt, agentTurnNode, agentType } from "../nodes/agent/execute.js";
import { producersOf } from "../nodes/branch/execute.js";
import { decidedByValue } from "../nodes/branch/settings.js";
import type { BuildFile, ManifestNode } from "./lower.js";
import { pieceOf } from "./pieces.js";
import { scopeLine, type ScopeParts } from "./scope-line.js";

export type OrchestratorManifest = { prefix: string; nodes: ManifestNode[]; wires: Wire[] };

export const orchestratorPath = "plugin/skills/run/SKILL.md";

type Settings = Record<string, unknown>;

const text = (value: unknown) => (typeof value === "string" ? value : "");

const nodeList = (ids: readonly string[]) => ids.map((id) => `NODE ${id}`).join(", ");

const quoted = (value: string) => JSON.stringify(value);

export function orchestratorSkill(manifest: OrchestratorManifest, scope: ScopeParts): BuildFile {
  const { prefix, nodes, wires } = manifest;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const thenWires = wires.filter((wire) => wire.kind === "then");
  const outOf = (id: string, port?: string) =>
    thenWires
      .filter((wire) => wire.from.node === id && (port === undefined || wire.from.port === port))
      .map((wire) => wire.to.node);
  const into = (id: string) =>
    thenWires.filter((wire) => wire.to.node === id).map((wire) => wire.from.node);
  const inside = (id: string) => nodes.filter((node) => node.parent === id).map((node) => node.id);
  const forkOf = (id: string) => into(id).find((from) => byId.get(from)?.type === "fork");

  const dispatch = (node: ManifestNode) =>
    `\`${agentType(prefix, pieceOf(node))}\` with the prompt ${quoted(agentPrompt(agentTurnNode(node)))}`;
  const branchCall = (id: string) => {
    const node = byId.get(id);
    return node?.type === "agent" ? dispatch(node) : `NODE ${id}`;
  };

  const step = (node: ManifestNode): string => {
    const settings = node.settings as Settings;
    switch (node.type) {
      case "trigger":
        return "the run starts here.";
      case "agent": {
        const fork = forkOf(node.id);
        return fork === undefined
          ? `dispatch ${dispatch(node)}, and wait for it to return.`
          : `a branch of NODE ${fork}, dispatched there; wait for it to return.`;
      }
      case "gate":
        return `ask in the chat: ${quoted(text(settings.shown))}, and wait for the answer before going on${settings.skippable === true ? " (it may be skipped)" : ""}.`;
      case "ask": {
        const options = Array.isArray(settings.options) ? settings.options.map(String) : [];
        return `ask in the chat: ${quoted(text(settings.question))} (options: ${options.join(", ")}), and wait for the answer.`;
      }
      case "loop": {
        const atCap =
          settings.onCap === "ask" ? "ask in the chat what to do" : "stop the run as failed";
        return `repeat the steps inside it (${nodeList(inside(node.id))}) until ${text(settings.condition)}, at most ${String(settings.cap)} rounds; at the cap, ${atCap}.`;
      }
      case "foreach":
        return `for each item listed in \`${text(settings.file)}\`, run the steps inside it (${nodeList(inside(node.id))}) once, passing the item along.`;
      case "branch": {
        const paths = `if yes, go to ${nodeList(outOf(node.id, "yes"))}; if no, go to ${nodeList(outOf(node.id, "no"))}.`;
        if (!decidedByValue(settings)) {
          return `read the value of \`${text(settings.variable)}\` from the build summary in CLAUDE.md; ${paths}`;
        }
        const name = text(settings.value);
        return `read \`${name}\` from the json answer the latest of ${nodeList([...producersOf(nodes, name)])} returned (true is yes, false is no); if it is missing or malformed, ask in the chat for yes or no and never guess; ${paths}`;
      }
      case "fork":
        return `dispatch every branch in one message, in parallel: ${outOf(node.id).map(branchCall).join("; ")}.`;
      case "join":
        return settings.wait === "first"
          ? `continue with the first branch result that returns (${nodeList(into(node.id))}); the others are ignored.`
          : `continue once every branch has returned (${nodeList(into(node.id))}).`;
      case "hardstop":
        return `hard rule: if ${text(settings.condition)}, stop the run at once and show ${text(settings.shown)}.`;
      case "output":
        return `the run ends here; its result is \`${text(settings.name)}\` (${text(settings.type)}), handed back to the user, not a file any step writes.`;
    }
  };

  const next = (node: ManifestNode) => {
    if (node.type === "branch" || node.type === "fork") return "";
    const children = new Set(inside(node.id));
    const after = outOf(node.id).filter((id) => !children.has(id));
    return after.length === 0 ? "" : ` Then go on to ${nodeList(after)}.`;
  };

  const description = `${scopeLine(scope)} Runs this build's flow in plain Claude Code, one step at a time: type /${prefix}:run. Use when running this build's whole flow without the Flowdeck app.`;
  const steps = nodes.map(
    (node, index) => `${index + 1}. NODE ${node.id} (${node.label}): ${step(node)}${next(node)}`,
  );
  return {
    path: orchestratorPath,
    content: [
      "---",
      `name: ${quoted("run")}`,
      `description: ${quoted(description)}`,
      "---",
      `# Run ${prefix}`,
      "",
      "Run these steps in order. Agent and Fork steps only hand off: each goes to its agents; never do that work yourself. Do every other step as its line says. Wait for each step's result before the next.",
      "",
      handoffFolderLine(scope.repo),
      "",
      ...steps,
      "",
    ].join("\n"),
  };
}
