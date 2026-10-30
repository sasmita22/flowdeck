import type { RunSnapshot } from "../../core/run/snapshot.js";

export type EngineRequest = {
  id: number;
  type: "version" | "store-status" | "save-flow" | "load-latest-flow" | "start-run";
  payload?: unknown;
};

export type EngineResponse =
  { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };

export type EnginePush = { push: "run-state"; value: RunSnapshot };

export type EngineMessage = EngineResponse | EnginePush;

export type StoreOpenResult = { kind: "ready" } | { kind: "error"; message: string };
