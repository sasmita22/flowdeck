import type { EngineRequest, EngineResponse, StoreOpenResult } from "./protocol.js";

export type EngineHandlerOptions = { version: string; openStore: () => void };

export type EngineHandler = { handle(request: EngineRequest): EngineResponse };

export function createEngineHandler(options: EngineHandlerOptions): EngineHandler {
  let storeStatus: StoreOpenResult | undefined;

  const openStoreOnce = (): StoreOpenResult => {
    if (storeStatus !== undefined) return storeStatus;
    try {
      options.openStore();
      storeStatus = { kind: "ready" };
    } catch (error) {
      storeStatus = {
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    return storeStatus;
  };

  return {
    handle(request) {
      switch (request.type) {
        case "version":
          return { id: request.id, ok: true, value: options.version };
        case "store-status":
          return { id: request.id, ok: true, value: openStoreOnce() };
      }
    },
  };
}
