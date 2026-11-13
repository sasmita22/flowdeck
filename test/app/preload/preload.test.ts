import { beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  bridgeChannels,
  engineCalls,
  type EngineCalls,
  type FlowdeckBridge,
} from "../../../src/app/preload/bridge.js";
import type { BuildAnswer } from "../../../src/core/compiler/build-report.js";
import type { SnapshotKey } from "../../../src/core/run/store.js";

type Handler = (event: unknown, ...args: unknown[]) => void;

const electron = vi.hoisted(() => {
  const listeners = new Map<string, Handler[]>();
  const exposed: Record<string, unknown> = {};
  return {
    exposed,
    listeners,
    emit(channel: string, ...args: unknown[]) {
      for (const handler of [...(listeners.get(channel) ?? [])])
        handler({ sender: "ipc" }, ...args);
    },
    ipcRenderer: {
      invoke: vi.fn(async (channel: string) => `answer for ${channel}`),
      send: vi.fn(),
      on: vi.fn((channel: string, handler: Handler) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
      }),
      removeListener: vi.fn((channel: string, handler: Handler) => {
        listeners.set(
          channel,
          (listeners.get(channel) ?? []).filter((registered) => registered !== handler),
        );
      }),
    },
    contextBridge: {
      exposeInMainWorld: vi.fn((key: string, api: unknown) => {
        exposed[key] = api;
      }),
    },
  };
});

vi.mock("electron", () => ({
  contextBridge: electron.contextBridge,
  ipcRenderer: electron.ipcRenderer,
}));

describe("preload run-state wiring", () => {
  let bridge: FlowdeckBridge;

  beforeAll(async () => {
    await import("../../../src/app/preload/preload.js");
    bridge = electron.exposed["flowdeck"] as FlowdeckBridge;
  });

  it.each([
    ["openFlow", "flowdeck:open-flow", { flowId: "flow-a" }],
    ["listFlows", "flowdeck:list-flows", undefined],
    ["renameFlow", "flowdeck:rename-flow", { flowId: "flow-a", name: "Weekly" }],
    ["pinFlow", "flowdeck:pin-flow", { flowId: "flow-a", pinned: true }],
    [
      "buildVersion",
      "flowdeck:build-version",
      {
        flowId: "flow-a",
        version: 2,
        name: "fix-login",
        repo: "/code/shop",
        base: "main",
        values: { ticket: "FD-1", deep: true },
      },
    ],
    ["listBuilds", "flowdeck:list-builds", undefined],
    ["buildFiles", "flowdeck:build-files", { buildId: "b1" }],
    ["buildPicture", "flowdeck:build-picture", { buildId: "b1" }],
    ["buildPicture", "flowdeck:build-picture", { pendingId: "pending-1" }],
    ["runBuild", "flowdeck:run-build", { buildId: "b1", auto: true }],
    ["runOptions", "flowdeck:run-options", { buildId: "b1" }],
    ["stopRun", "flowdeck:stop-run", { runId: "run-1" }],
    ["deleteBuild", "flowdeck:delete-build", { buildId: "b1" }],
    ["doctorWorktrees", "flowdeck:doctor-worktrees", undefined],
    ["defaultBranch", "flowdeck:default-branch", { repo: "/code/shop" }],
    ["listRuns", "flowdeck:list-runs", undefined],
    ["loadRun", "flowdeck:load-run", { runId: "run-1" }],
    ["doctor", "flowdeck:doctor", { connectors: ["slack"] }],
    ["listBuildProgress", "flowdeck:build-progress-list", undefined],
    ["stopBuild", "flowdeck:build-stop", { pendingId: "pending-1" }],
    ["getBuildActivity", "flowdeck:build-activity", { pendingId: "pending-1" }],
    [
      "buildRebuild",
      "flowdeck:build-rebuild",
      {
        pendingId: "pending-1",
        answers: [
          {
            nodeId: "s1",
            otherNodeId: "s0",
            text: "Which command runs the tests?",
            answer: "npm test",
          },
        ],
      },
    ],
    ["startBlueprintSession", "flowdeck:blueprint-session-start", { flowId: "flow-a" }],
    ["stopBlueprintSession", "flowdeck:blueprint-session-stop", { flowId: "flow-a" }],
  ] as const)(
    "%s invokes %s with its payload and returns its answer",
    async (method, channel, payload) => {
      expect(bridge[method]).toEqual(expect.any(Function));
      const call = bridge[method] as (payload?: unknown) => Promise<unknown>;

      await expect(call(payload)).resolves.toBe(`answer for ${channel}`);
      expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(channel, payload);
    },
  );

  it.each([
    ["pin-flow", "pinFlow"],
    ["delete-build", "deleteBuild"],
    ["doctor-worktrees", "doctorWorktrees"],
    ["default-branch", "defaultBranch"],
    ["build-progress-list", "listBuildProgress"],
    ["build-stop", "stopBuild"],
    ["build-activity", "getBuildActivity"],
    ["build-rebuild", "buildRebuild"],
    ["build-picture", "buildPicture"],
    ["blueprint-session-start", "startBlueprintSession"],
    ["blueprint-session-stop", "stopBlueprintSession"],
  ] as const)(
    "relays %s as an engine call, so main guards it like every engine call",
    (request, method) => {
      expect(engineCalls[method]).toEqual({ channel: `flowdeck:${request}`, request });
    },
  );

  it("keeps stopping every blueprint session to main, out of the renderer's engine calls", () => {
    const requests = Object.values(engineCalls).map((call) => call.request);

    expect(requests).not.toContain("blueprint-session-stop-all");
  });

  it("types each blueprint session call's payload as the engine reads it", () => {
    expectTypeOf<Parameters<EngineCalls["startBlueprintSession"]>[0]>().toEqualTypeOf<{
      flowId: string;
    }>();
    expectTypeOf<Parameters<EngineCalls["stopBlueprintSession"]>[0]>().toEqualTypeOf<{
      flowId: string;
    }>();
  });

  it("types each build call's payload as the engine reads it", () => {
    expectTypeOf<Parameters<EngineCalls["buildVersion"]>[0]>().toEqualTypeOf<{
      flowId: string;
      version: number;
      name: string;
      repo?: string;
      base?: string;
      values: Record<string, string | boolean>;
      buildModel?: string;
    }>();
    expectTypeOf<Parameters<EngineCalls["buildFiles"]>[0]>().toEqualTypeOf<{ buildId: string }>();
    expectTypeOf<Parameters<EngineCalls["buildPicture"]>[0]>().toEqualTypeOf<SnapshotKey>();
    expectTypeOf<Parameters<EngineCalls["runBuild"]>[0]>().toEqualTypeOf<{
      buildId: string;
      auto?: boolean;
    }>();
    expectTypeOf<Parameters<EngineCalls["runOptions"]>[0]>().toEqualTypeOf<{ buildId: string }>();
    expectTypeOf<Parameters<EngineCalls["deleteBuild"]>[0]>().toEqualTypeOf<{ buildId: string }>();
    expectTypeOf<Parameters<EngineCalls["doctorWorktrees"]>>().toEqualTypeOf<[]>();
    expectTypeOf<Parameters<EngineCalls["defaultBranch"]>[0]>().toEqualTypeOf<{ repo: string }>();
    expectTypeOf<Parameters<EngineCalls["listBuildProgress"]>>().toEqualTypeOf<[]>();
    expectTypeOf<Parameters<EngineCalls["stopBuild"]>[0]>().toEqualTypeOf<{ pendingId: string }>();
    expectTypeOf<Parameters<EngineCalls["buildRebuild"]>[0]>().toEqualTypeOf<{
      pendingId: string;
      answers: BuildAnswer[];
    }>();
  });

  it.each([
    ["getRunState", "flowdeck:get-run-state"],
    ["getActivity", "flowdeck:get-activity"],
    ["getWait", "flowdeck:get-wait"],
  ] as const)("%s invokes %s for the given run and returns its answer", async (method, channel) => {
    await expect(bridge[method]("run-2")).resolves.toBe(`answer for ${channel}`);
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(channel, "run-2");
  });

  it("invokes flowdeck:answer-wait with the answer for answerWait and returns its answer", async () => {
    const answer = { waitId: "wait-1", reply: { decision: "approve" } } as const;

    await expect(bridge.answerWait(answer)).resolves.toBe("answer for flowdeck:answer-wait");
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith("flowdeck:answer-wait", answer);
  });

  it("invokes flowdeck:workspace-info with the working folder for workspaceInfo and returns its answer", async () => {
    const workingFolder = { kind: "path", path: "/code/shop" } as const;

    await expect(bridge.workspaceInfo(workingFolder)).resolves.toBe(
      "answer for flowdeck:workspace-info",
    );
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(
      "flowdeck:workspace-info",
      workingFolder,
    );
  });

  it("hands each flowdeck:run-state snapshot to the listener without the event", () => {
    const listener = vi.fn();
    const unsubscribe = bridge.onRunState(listener);

    electron.emit("flowdeck:run-state", { runId: "run-1" });

    expect(electron.ipcRenderer.on).toHaveBeenCalledWith(
      "flowdeck:run-state",
      expect.any(Function),
    );
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ runId: "run-1" });
    unsubscribe();
  });

  it("removes the same handler it registered on unsubscribe, so later snapshots are not handed on", () => {
    const listener = vi.fn();
    electron.ipcRenderer.on.mockClear();
    const unsubscribe = bridge.onRunState(listener);
    const registered = electron.ipcRenderer.on.mock.calls[0]?.[1];

    unsubscribe();
    electron.emit("flowdeck:run-state", { runId: "run-1" });

    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(
      "flowdeck:run-state",
      registered,
    );
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("preload terminal wiring", () => {
  let bridge: FlowdeckBridge;

  beforeAll(async () => {
    await import("../../../src/app/preload/preload.js");
    bridge = electron.exposed["flowdeck"] as FlowdeckBridge;
  });

  it("invokes flowdeck:open-terminal with the run and the size for openTerminal and returns its answer", async () => {
    await expect(bridge.openTerminal("run-2", { cols: 80, rows: 24 })).resolves.toBe(
      "answer for flowdeck:open-terminal",
    );
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(
      "flowdeck:open-terminal",
      "run-2",
      {
        cols: 80,
        rows: 24,
      },
    );
  });

  it("invokes flowdeck:get-terminal-status for the run for getTerminalStatus and returns its answer", async () => {
    await expect(bridge.getTerminalStatus("run-2")).resolves.toBe(
      "answer for flowdeck:get-terminal-status",
    );
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(
      "flowdeck:get-terminal-status",
      "run-2",
    );
  });

  it("invokes flowdeck:pop-out-terminal for the run for popOutTerminal", async () => {
    await expect(bridge.popOutTerminal("run-2")).resolves.toBe(
      "answer for flowdeck:pop-out-terminal",
    );
    expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith(
      "flowdeck:pop-out-terminal",
      "run-2",
    );
  });

  it("sends flowdeck:terminal-input with the run and the data for writeTerminal", () => {
    bridge.writeTerminal("run-2", "a");

    expect(electron.ipcRenderer.send).toHaveBeenLastCalledWith(
      "flowdeck:terminal-input",
      "run-2",
      "a",
    );
  });

  it("sends flowdeck:terminal-resize with the run and the size for resizeTerminal", () => {
    bridge.resizeTerminal("run-2", { cols: 120, rows: 40 });

    expect(electron.ipcRenderer.send).toHaveBeenLastCalledWith(
      "flowdeck:terminal-resize",
      "run-2",
      { cols: 120, rows: 40 },
    );
  });

  it("sends flowdeck:close-terminal with the run for closeTerminal", () => {
    bridge.closeTerminal("run-2");

    expect(electron.ipcRenderer.send).toHaveBeenLastCalledWith("flowdeck:close-terminal", "run-2");
  });

  it.each([
    [
      "onTerminalStatus",
      "flowdeck:terminal-status",
      { runId: "run-1", status: { available: true, attached: false } },
    ],
    ["onTerminalData", "flowdeck:terminal-data", { runId: "run-1", data: "output" }],
    ["onActivity", "flowdeck:activity", { runId: "run-1", entry: { id: 1 } }],
    [
      "onWait",
      "flowdeck:wait",
      { runId: "run-1", value: { waitId: "wait-1", request: { nodeId: "gate" } } },
    ],
    [
      "onBuildProgress",
      "flowdeck:build-progress",
      { pendingId: "pending-1", flowId: "flow-a", progress: { steps: [] } },
    ],
    [
      "onBuildActivity",
      "flowdeck:build-activity-push",
      { pendingId: "pending-1", entry: { id: 1 } },
    ],
  ] as const)(
    "%s hands each %s payload to the listener without the event, and stops after unsubscribe",
    (method, channel, payload) => {
      expect(bridge[method]).toEqual(expect.any(Function));
      const listener = vi.fn();
      electron.ipcRenderer.on.mockClear();
      const unsubscribe = bridge[method](listener);
      const registered = electron.ipcRenderer.on.mock.calls[0]?.[1];

      electron.emit(channel, payload);

      expect(electron.ipcRenderer.on).toHaveBeenCalledWith(channel, expect.any(Function));
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(payload);

      unsubscribe();
      electron.emit(channel, payload);

      expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(channel, registered);
      expect(listener).toHaveBeenCalledTimes(1);
    },
  );
});

describe("preload blueprint tool wiring", () => {
  let bridge: FlowdeckBridge;

  beforeAll(async () => {
    await import("../../../src/app/preload/preload.js");
    bridge = electron.exposed["flowdeck"] as FlowdeckBridge;
  });

  it.each([
    ["toolCall", "flowdeck:tool-call"],
    ["answerToolCall", "flowdeck:answer-tool-call"],
    ["toolTurnEnd", "flowdeck:tool-turn-end"],
  ] as const)("names the %s channel %s", (key, channel) => {
    expect((bridgeChannels as Record<string, string>)[key]).toBe(channel);
  });

  it.each([
    [
      "onToolCall",
      "flowdeck:tool-call",
      {
        requestId: "1",
        session: "fd-bp-flow-a",
        name: "change_node",
        input: { nodeId: "s1", settings: { prompt: "Run the tests" } },
      },
    ],
    ["onToolTurnEnd", "flowdeck:tool-turn-end", { session: "fd-bp-flow-a" }],
  ] as const)(
    "%s hands each %s payload to the listener without the event, and stops after unsubscribe",
    (method, channel, payload) => {
      expect(bridge[method]).toEqual(expect.any(Function));
      const listener = vi.fn();
      electron.ipcRenderer.on.mockClear();
      const unsubscribe = bridge[method](listener);
      const registered = electron.ipcRenderer.on.mock.calls[0]?.[1];

      electron.emit(channel, payload);

      expect(electron.ipcRenderer.on).toHaveBeenCalledWith(channel, expect.any(Function));
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(payload);

      unsubscribe();
      electron.emit(channel, payload);

      expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(channel, registered);
      expect(listener).toHaveBeenCalledTimes(1);
    },
  );

  it("sends flowdeck:answer-tool-call with the request id and the result for answerToolCall", () => {
    expect(bridge.answerToolCall).toEqual(expect.any(Function));
    const result = { ok: true, nodeId: "s2", problems: [] };

    bridge.answerToolCall("7", result);

    expect(electron.ipcRenderer.send).toHaveBeenLastCalledWith(
      "flowdeck:answer-tool-call",
      "7",
      result,
    );
  });
});
