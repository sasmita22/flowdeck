import { describe, expect, it } from "vitest";
import type { FlowdeckBridge, StoreStatus } from "../../../src/app/preload/bridge.js";
import { createAppStore } from "../../../src/app/renderer/app-store.js";

const bridge = (
  version: () => Promise<string>,
  storeStatus: () => Promise<StoreStatus>,
): FlowdeckBridge => ({ version, storeStatus });

describe("createAppStore", () => {
  it("starts with no version, no error and a loading status", () => {
    const store = createAppStore(
      bridge(
        () => Promise.resolve("0.0.0"),
        () => Promise.resolve({ kind: "ready" }),
      ),
    );

    expect(store.getState()).toMatchObject({
      version: null,
      versionError: null,
      status: { kind: "loading" },
    });
  });

  it("holds the version and the status the bridge returns after load", async () => {
    const store = createAppStore(
      bridge(
        () => Promise.resolve("0.0.0"),
        () => Promise.resolve({ kind: "ready" }),
      ),
    );

    await store.getState().load();

    expect(store.getState()).toMatchObject({
      version: "0.0.0",
      versionError: null,
      status: { kind: "ready" },
    });
  });

  it("keeps the version empty and records the error when the version call rejects", async () => {
    const store = createAppStore(
      bridge(
        () => Promise.reject(new Error("timeout")),
        () => Promise.resolve({ kind: "ready" }),
      ),
    );

    await store.getState().load();

    expect(store.getState()).toMatchObject({ version: null, versionError: "timeout" });
  });

  it("shows a rejected status call as an error status", async () => {
    const store = createAppStore(
      bridge(
        () => Promise.resolve("0.0.0"),
        () => Promise.reject(new Error("engine exited")),
      ),
    );

    await store.getState().load();

    expect(store.getState().status).toEqual({ kind: "error", message: "engine exited" });
  });
});
