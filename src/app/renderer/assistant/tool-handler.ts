import { z } from "zod";
import type { StoreApi } from "zustand/vanilla";
import { blueprintSessionName } from "../../../core/compiler/blueprint-session.js";
import { flowProblems } from "../../../core/compiler/flow-problems.js";
import { checkEdit, newProblems, type BlueprintEdit } from "../../../core/flow/blueprint-edits.js";
import {
  searchBlueprints,
  toolCallSchema,
  toolInputs,
  type ToolCall,
} from "../../../core/flow/blueprint-tools.js";
import { flowSummarySchema, openedFlowSchema } from "../../../core/flow/flow-store.js";
import type { Flow, Node } from "../../../core/flow/schema.js";
import type { FlowdeckBridge } from "../../preload/bridge.js";
import { addNode, addWire, deleteNodes, updateNode, type Command } from "../canvas/commands.js";
import { nextNodeId, placeNode, selectDirty, type CanvasState } from "../canvas/store.js";
import type { NavState } from "../nav-store.js";
import type { SaveState } from "../save-store.js";

export type ToolHandlerBridge = Pick<
  FlowdeckBridge,
  "openFlow" | "listFlows" | "onToolCall" | "onToolTurnEnd" | "answerToolCall"
>;

type Answer = { ok: true; [key: string]: unknown } | { ok: false; reason: string };

const refuse = (reason: string): Answer => ({ ok: false, reason });

const notReady = "the canvas is not ready";

const offBlueprint =
  "Edits go only to the blueprint this agent was opened on, and only while it is open in the editor.";

const firstPosition = { x: 80, y: 80 };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const targetOf = (input: unknown): string | undefined => {
  const parsed = toolInputs.read_blueprint.safeParse(input);
  return parsed.success ? parsed.data.blueprint : undefined;
};

export function createToolHandler({
  bridge,
  canvas,
  save,
  nav,
}: {
  bridge: ToolHandlerBridge;
  canvas: StoreApi<CanvasState>;
  save: StoreApi<SaveState>;
  nav: StoreApi<Pick<NavState, "page">>;
}): void {
  const isOpen = (blueprint: string | undefined) =>
    blueprint === undefined || blueprint === save.getState().flowId;

  const isOwnOpenBlueprint = (session: string) => {
    const { flowId } = save.getState();
    return (
      nav.getState().page.name === "editor" &&
      flowId !== null &&
      session === blueprintSessionName(flowId)
    );
  };

  const readSaved = async (flowId: string) => {
    const reply = await bridge.openFlow({ flowId });
    return reply === null ? null : openedFlowSchema.parse(reply);
  };

  const listSaved = async () => z.array(flowSummarySchema).parse(await bridge.listFlows());

  const commandFor = (flow: Flow, edit: BlueprintEdit): { command: Command; nodeId?: string } => {
    switch (edit.tool) {
      case "add_node": {
        const nodeId = nextNodeId(edit.type, flow);
        const position = placeNode(flow, edit.type, firstPosition, edit.parent);
        const { type, label, parent, settings } = edit;
        const node = { id: nodeId, type, label, position, settings };
        return {
          command: addNode((parent === undefined ? node : { ...node, parent }) as Node),
          nodeId,
        };
      }
      case "wire":
        return { command: addWire(edit.wire) };
      case "change_node": {
        const node = flow.nodes.find(({ id }) => id === edit.nodeId) as Node;
        const { label = node.label, settings = node.settings } = edit;
        return { command: updateNode({ ...node, label, settings } as Node) };
      }
      case "delete_node":
        return { command: deleteNodes(flow, [edit.nodeId]) };
      case "set_variable":
        return { command: canvas.getState().variableCommand(edit.variable) };
    }
  };

  const applyEdit = (session: string, name: string, input: unknown): Answer => {
    if (!isOwnOpenBlueprint(session)) return refuse(offBlueprint);
    const before = canvas.getState().flow;
    const check = checkEdit(before, name, input);
    if (!check.ok) return check;
    const { command, nodeId } = commandFor(before, check.edit);
    if (!canvas.getState().applyAgent(command)) return refuse(notReady);
    const problems = newProblems(before, canvas.getState().flow);
    return nodeId === undefined ? { ok: true, problems } : { ok: true, nodeId, problems };
  };

  const readBlueprint = async (input: unknown): Promise<Answer> => {
    const blueprint = targetOf(input);
    if (blueprint === undefined || isOpen(blueprint)) {
      const { flow } = canvas.getState();
      return {
        ok: true,
        flow,
        unsaved: selectDirty(canvas.getState()),
        problems: flowProblems(flow),
      };
    }
    const saved = await readSaved(blueprint);
    if (saved?.flow == null) return refuse(`No blueprint "${blueprint}".`);
    return { ok: true, ...saved, problems: flowProblems(saved.flow) };
  };

  const searchSaved = async (input: unknown): Promise<Answer> => {
    const parsed = toolInputs.search_blueprints.safeParse(input);
    if (!parsed.success) return refuse(z.prettifyError(parsed.error));
    const summaries = await listSaved();
    const entries = await Promise.all(
      summaries.map(async (summary) => {
        const flow = (await readSaved(summary.flowId))?.flow;
        return flow == null ? [] : [{ summary, name: summary.name, flow }];
      }),
    );
    const found = searchBlueprints(entries.flat(), parsed.data.query);
    return { ok: true, blueprints: found.map(({ summary }) => summary) };
  };

  const answer = async ({ session, name, input }: ToolCall): Promise<Answer> => {
    if (!canvas.getState().ready) return refuse(notReady);
    switch (name) {
      case "read_blueprint":
        return readBlueprint(input);
      case "list_blueprints":
        return { ok: true, blueprints: await listSaved() };
      case "search_blueprints":
        return searchSaved(input);
      default:
        return applyEdit(session, name, input);
    }
  };

  bridge.onToolCall((raw) => {
    const call = toolCallSchema.safeParse(raw);
    if (!call.success) return;
    const reply = (result: Answer) => bridge.answerToolCall(call.data.requestId, result);
    answer(call.data).then(reply, (error: unknown) => reply(refuse(messageOf(error))));
  });

  bridge.onToolTurnEnd(() => canvas.getState().endAgentGroup());
}
