import type { OpenSessionOptions, OpenedSession } from "../../src/core/run/execute.js";
import type { HookEventKind } from "../../src/ports/event-source.js";
import { FakeEventSource } from "../fakes/fake-event-source.js";

export type FakeTurn = "done" | "fail" | "hold";

export type FakeTurnHandler = (
  nodeId: string,
  options: OpenSessionOptions,
) => FakeTurn | Promise<FakeTurn>;

const dispatched = /subagent_type "([^"]+)" and the prompt "NODE ([^\\"]+)/;

export function fakeClaudeSession(turn: FakeTurnHandler = () => "done") {
  const events = new FakeEventSource();
  const sent: string[] = [];
  const opened: OpenSessionOptions[] = [];
  const publish = (kind: HookEventKind, sessionId: string, payload: object) =>
    events.publish({ kind, sessionId, payload: { ...payload, flowdeck_hook_at: Date.now() } });

  const finish = (sessionId: string, agentType: string, nodeId: string, outcome: FakeTurn) => {
    if (outcome === "done") {
      publish("PostToolUse", sessionId, {
        tool_name: "Agent",
        tool_input: { subagent_type: agentType, prompt: `NODE ${nodeId}\nGo` },
        tool_use_id: `toolu-${nodeId}-${sent.length}`,
        tool_response: {
          status: "completed",
          agentId: `agent-${nodeId}`,
          agentType,
          content: [{ type: "text", text: `${nodeId} done` }],
        },
      });
    }
    publish("Stop", sessionId, { last_assistant_message: "DONE" });
  };

  const openSession = async (options: OpenSessionOptions): Promise<OpenedSession> => {
    opened.push(options);
    const sessionId = options.claudeSessionId;
    return {
      sessionId,
      session: { ensureStarted: async () => undefined },
      prompts: {
        sendPrompt: async (text) => {
          sent.push(text);
          const match = dispatched.exec(text);
          if (match === null) {
            setTimeout(() => publish("Stop", sessionId, {}), 0);
            return;
          }
          const [, agentType = "", nodeId = ""] = match;
          const outcome = await turn(nodeId, options);
          if (outcome !== "hold")
            setTimeout(() => finish(sessionId, agentType, nodeId, outcome), 0);
        },
        interrupt: async () => undefined,
      },
      stop: async () => undefined,
    };
  };

  const sentTo = (nodeId: string) =>
    sent.filter((text) => text.includes(`the prompt "NODE ${nodeId}\\n`));

  return {
    events,
    sent,
    sentTo,
    opened,
    startEvents: async () => ({ events, stop: async () => undefined }),
    openSession,
  };
}
