import { parseFlow } from "../../core/flow/schema.js";
import type { FlowStore, LoadLatestFlowResult, SaveFlowResult } from "../../ports/flow-store.js";
import type { Store } from "../../ports/store.js";
import type { EngineRequest, EngineResponse, StoreOpenResult } from "./protocol.js";

export type EngineStores = { runs: Store; flows: FlowStore };

export type EngineHandlerOptions = { version: string; openStores: () => EngineStores };

export type EngineHandler = { handle(request: EngineRequest): EngineResponse };

type Opened = { kind: "ready"; stores: EngineStores } | { kind: "error"; message: string };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createEngineHandler(options: EngineHandlerOptions): EngineHandler {
  let opened: Opened | undefined;

  const openStoresOnce = (): Opened => {
    if (opened !== undefined) return opened;
    try {
      opened = { kind: "ready", stores: options.openStores() };
    } catch (error) {
      opened = { kind: "error", message: messageOf(error) };
    }
    return opened;
  };

  const storeStatus = (): StoreOpenResult => {
    const result = openStoresOnce();
    return result.kind === "ready" ? { kind: "ready" } : result;
  };

  const saveFlow = (payload: unknown): SaveFlowResult => {
    const result = openStoresOnce();
    if (result.kind === "error") return result;
    try {
      const saved = result.stores.flows.save(parseFlow(payload));
      return { kind: "saved", flowId: saved.flowId, version: saved.version };
    } catch (error) {
      return { kind: "error", message: messageOf(error) };
    }
  };

  const loadLatestFlow = (): LoadLatestFlowResult => {
    const result = openStoresOnce();
    if (result.kind === "error") return result;
    try {
      const latest = result.stores.flows.loadLatest();
      return latest === null ? { kind: "empty" } : { kind: "loaded", flow: latest.flow };
    } catch (error) {
      return { kind: "error", message: messageOf(error) };
    }
  };

  return {
    handle(request) {
      switch (request.type) {
        case "version":
          return { id: request.id, ok: true, value: options.version };
        case "store-status":
          return { id: request.id, ok: true, value: storeStatus() };
        case "save-flow":
          return { id: request.id, ok: true, value: saveFlow(request.payload) };
        case "load-latest-flow":
          return { id: request.id, ok: true, value: loadLatestFlow() };
      }
    },
  };
}
