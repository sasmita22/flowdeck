export type StoreStatus = { kind: "ready" } | { kind: "error"; message: string };

export type CloseAnswer = "close" | "cancel";

export const engineCalls = {
  openFlow: { channel: "flowdeck:open-flow", request: "open-flow" },
  listFlows: { channel: "flowdeck:list-flows", request: "list-flows" },
  renameFlow: { channel: "flowdeck:rename-flow", request: "rename-flow" },
  buildVersion: { channel: "flowdeck:build-version", request: "build-version" },
  listBuilds: { channel: "flowdeck:list-builds", request: "list-builds" },
  buildFiles: { channel: "flowdeck:build-files", request: "build-files" },
  runBuild: { channel: "flowdeck:run-build", request: "run-build" },
  listRuns: { channel: "flowdeck:list-runs", request: "list-runs" },
  loadRun: { channel: "flowdeck:load-run", request: "load-run" },
  doctor: { channel: "flowdeck:doctor", request: "doctor" },
} as const;

export type EngineCalls = {
  openFlow(payload: { flowId?: string }): Promise<unknown>;
  listFlows(): Promise<unknown>;
  renameFlow(payload: { flowId: string; name: string }): Promise<unknown>;
  buildVersion(payload: { flowId: string; version: number }): Promise<unknown>;
  listBuilds(): Promise<unknown>;
  buildFiles(payload: { hash: string }): Promise<unknown>;
  runBuild(payload: { hash: string }): Promise<unknown>;
  listRuns(): Promise<unknown>;
  loadRun(payload: { runId: string }): Promise<unknown>;
  doctor(payload: { connectors: string[] }): Promise<unknown>;
};

export type FlowdeckBridge = EngineCalls & {
  version(): Promise<string>;
  storeStatus(): Promise<StoreStatus>;
  saveFlow(payload: unknown): Promise<unknown>;
  setDirty(dirty: boolean): void;
  onCloseRequest(listener: () => void): () => void;
  answerClose(answer: CloseAnswer): void;
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
  getWait(): Promise<unknown>;
  onWait(listener: (value: unknown) => void): () => void;
  answerWait(answer: unknown): Promise<boolean>;
  workspaceInfo(workingFolder: unknown): Promise<unknown>;
};

export const bridgeChannels = {
  version: "flowdeck:version",
  storeStatus: "flowdeck:store-status",
  saveFlow: "flowdeck:save-flow",
  setDirty: "flowdeck:set-dirty",
  closeRequest: "flowdeck:close-request",
  closeAnswer: "flowdeck:close-answer",
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
  getWait: "flowdeck:get-wait",
  wait: "flowdeck:wait",
  answerWait: "flowdeck:answer-wait",
  workspaceInfo: "flowdeck:workspace-info",
} as const;
