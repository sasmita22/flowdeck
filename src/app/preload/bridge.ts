export type StoreStatus = { kind: "ready" } | { kind: "error"; message: string };

export type FlowdeckBridge = {
  version(): Promise<string>;
  storeStatus(): Promise<StoreStatus>;
};

export const bridgeChannels = {
  version: "flowdeck:version",
  storeStatus: "flowdeck:store-status",
} as const;
