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
  startRun(): Promise<unknown>;
  getRunState(): Promise<unknown>;
  onRunState(listener: (snapshot: unknown) => void): () => void;
  openTerminal(size: { cols: number; rows: number }): Promise<unknown>;
  getTerminalStatus(): Promise<unknown>;
  writeTerminal(data: string): void;
  resizeTerminal(size: { cols: number; rows: number }): void;
  closeTerminal(): void;
  onTerminalStatus(listener: (status: unknown) => void): () => void;
  onTerminalData(listener: (data: unknown) => void): () => void;
  getActivity(): Promise<unknown>;
  onActivity(listener: (update: unknown) => void): () => void;
};

export const bridgeChannels = {
  version: "flowdeck:version",
  storeStatus: "flowdeck:store-status",
  saveFlow: "flowdeck:save-flow",
  loadLatestFlow: "flowdeck:load-latest-flow",
  setDirty: "flowdeck:set-dirty",
  closeRequest: "flowdeck:close-request",
  closeAnswer: "flowdeck:close-answer",
  startRun: "flowdeck:start-run",
  getRunState: "flowdeck:get-run-state",
  runState: "flowdeck:run-state",
  openTerminal: "flowdeck:open-terminal",
  getTerminalStatus: "flowdeck:get-terminal-status",
  terminalInput: "flowdeck:terminal-input",
  terminalResize: "flowdeck:terminal-resize",
  closeTerminal: "flowdeck:close-terminal",
  terminalStatus: "flowdeck:terminal-status",
  terminalData: "flowdeck:terminal-data",
  getActivity: "flowdeck:get-activity",
  activity: "flowdeck:activity",
} as const;
