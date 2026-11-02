import { describe, expect, it, vi } from "vitest";
import type { FlowdeckBridge, StoreStatus } from "../../../src/app/preload/bridge.js";
import { createAppStore } from "../../../src/app/renderer/app-store.js";

const bridge = (
  version: () => Promise<string>,
  storeStatus: () => Promise<StoreStatus>,
): FlowdeckBridge => ({
  version,
  storeStatus,
  saveFlow: vi.fn(),
  openFlow: vi.fn(),
  listFlows: vi.fn(),
  renameFlow: vi.fn(),
  buildVersion: vi.fn(),
  listBuilds: vi.fn(),
  buildFiles: vi.fn(),
  runBuild: vi.fn(),
  listRuns: vi.fn(),
  loadRun: vi.fn(),
  doctor: vi.fn(),
  runOptions: vi.fn(),
  stopRun: vi.fn(),
  retryNode: vi.fn(),
  resumeRun: vi.fn(),
  runCost: vi.fn(),
  listBranches: vi.fn(),
  setDirty: vi.fn(),
  onCloseRequest: vi.fn(() => () => {}),
  answerClose: vi.fn(),
  getRunState: vi.fn(),
  onRunState: vi.fn(() => () => {}),
  openTerminal: vi.fn(),
  getTerminalStatus: vi.fn(),
  writeTerminal: vi.fn(),
  resizeTerminal: vi.fn(),
  closeTerminal: vi.fn(),
  popOutTerminal: vi.fn(),
  onTerminalStatus: vi.fn(() => () => {}),
  onTerminalData: vi.fn(() => () => {}),
  getActivity: vi.fn(),
  onActivity: vi.fn(() => () => {}),
  getWait: vi.fn(async () => null),
  onWait: vi.fn(() => () => {}),
  answerWait: vi.fn(async () => false),
  workspaceInfo: vi.fn(async () => null),
});

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
