export type StoreStatus = { kind: "ready" } | { kind: "error"; message: string };

export type CloseAnswer = "close" | "cancel";

export type FlowdeckBridge = {
  version(): Promise<string>;
  storeStatus(): Promise<StoreStatus>;
  saveFlow(flow: unknown): Promise<unknown>;
  loadLatestFlow(): Promise<unknown>;
  setDirty(dirty: boolean): void;
  onCloseRequest(listener: () => void): () => void;
  answerClose(answer: CloseAnswer): void;
};

export const bridgeChannels = {
  version: "flowdeck:version",
  storeStatus: "flowdeck:store-status",
  saveFlow: "flowdeck:save-flow",
  loadLatestFlow: "flowdeck:load-latest-flow",
  setDirty: "flowdeck:set-dirty",
  closeRequest: "flowdeck:close-request",
  closeAnswer: "flowdeck:close-answer",
} as const;
