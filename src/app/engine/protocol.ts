export type EngineRequest = { id: number; type: "version" | "store-status" };

export type EngineResponse =
  { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };

export type StoreOpenResult = { kind: "ready" } | { kind: "error"; message: string };
