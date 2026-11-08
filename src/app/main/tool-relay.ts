import {
  blueprintToolDefinitions,
  canvasToolNames,
  type ToolCall,
} from "../../core/flow/blueprint-tools.js";
import type { ToolSocket, ToolSocketMessage } from "../../ports/tool-socket.js";
import type { EngineRequest } from "../engine/protocol.js";
import type { EngineRequestOptions } from "./engine-client.js";

export type ToolRelaySend = (channel: "toolCall" | "toolTurnEnd", payload?: ToolCall) => void;

export type ToolRelayRequestEngine = (
  type: EngineRequest["type"],
  payload: unknown,
  options: EngineRequestOptions,
) => Promise<unknown>;

export type ToolRelayOptions = {
  socket: ToolSocket;
  send: ToolRelaySend;
  requestEngine?: ToolRelayRequestEngine;
};

const buildToolTimeoutMs = 30_000;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export type ToolRelay = {
  start(path: string): Promise<void>;
  answer(requestId: string, result: unknown): void;
  failAll(reason: string): void;
  close(): Promise<void>;
};

export function createToolRelay({ socket, send, requestEngine }: ToolRelayOptions): ToolRelay {
  const pending = new Map<string, (result: unknown) => void>();
  let nextId = 1;

  const askRenderer = (session: string, name: string, input: unknown): Promise<unknown> => {
    const requestId = String(nextId++);
    return new Promise((resolve) => {
      pending.set(requestId, resolve);
      send("toolCall", { requestId, session, name, input });
    });
  };

  const askEngine = async (
    type: EngineRequest["type"],
    payload: unknown,
    wrap: (value: unknown) => object,
  ): Promise<unknown> => {
    if (requestEngine === undefined) return { ok: false, reason: "builds are not available" };
    try {
      return {
        ok: true,
        ...wrap(await requestEngine(type, payload, { timeoutMs: buildToolTimeoutMs })),
      };
    } catch (error) {
      return { ok: false, reason: messageOf(error) };
    }
  };

  const handle = async (message: ToolSocketMessage): Promise<unknown> => {
    switch (message.kind) {
      case "tools":
        return blueprintToolDefinitions();
      case "stop":
        send("toolTurnEnd");
        return undefined;
      case "call":
        if (message.name === "list_builds") {
          return askEngine("assistant-list-builds", undefined, (builds) => ({ builds }));
        }
        if (message.name === "read_build") {
          return askEngine("assistant-read-build", message.input, (read) => read as object);
        }
        if (!canvasToolNames.has(message.name)) {
          return { ok: false, reason: `unknown tool ${message.name}` };
        }
        return askRenderer(message.session, message.name, message.input);
    }
  };

  return {
    start: (path) => socket.listen(path, handle),
    answer(requestId, result) {
      const resolve = pending.get(requestId);
      if (resolve === undefined) return;
      pending.delete(requestId);
      resolve(result);
    },
    failAll(reason) {
      for (const resolve of pending.values()) resolve({ ok: false, reason });
      pending.clear();
    },
    close: () => socket.close(),
  };
}
