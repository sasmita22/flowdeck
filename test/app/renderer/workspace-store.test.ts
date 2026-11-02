import { describe, expect, it, vi } from "vitest";
import type { FlowdeckBridge } from "../../../src/app/preload/bridge.js";
import { createCanvasStore } from "../../../src/app/renderer/canvas/store.js";
import { createRunStore, type RunBridge } from "../../../src/app/renderer/run-store.js";
import { createSaveStore, type SaveBridge } from "../../../src/app/renderer/save-store.js";
import {
  createWorkspaceStore,
  selectWorkspaceLabel,
} from "../../../src/app/renderer/workspace-store.js";
import type { Flow } from "../../../src/core/flow/schema.js";
import { flow, prompt } from "../../fixtures/flow-builders.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const shop = { kind: "path", path: "/code/shop" } as const;
const blog = { kind: "path", path: "/code/blog" } as const;

const atFolder = (workingFolder: Flow["session"]["workingFolder"]): Flow => {
  const base = flow([prompt("prompt-1")], []);
  return { ...base, session: { ...base.session, workingFolder } };
};

const setup = (options: { latest?: Flow; saveFails?: boolean } = {}) => {
  let pushRun: (value: unknown) => void = () => undefined;
  const saveBridge = {
    saveFlow: vi.fn<(flow: unknown) => Promise<unknown>>(async () =>
      options.saveFails === true
        ? { kind: "error", message: "disk full" }
        : { kind: "saved", flowId: "flow-1", version: 1 },
    ),
    loadLatestFlow: vi.fn<() => Promise<unknown>>(async () => options.latest ?? null),
    setDirty: vi.fn<(dirty: boolean) => void>(),
    onCloseRequest: vi.fn(() => () => {}),
    answerClose: vi.fn<(answer: "close" | "cancel") => void>(),
  } satisfies SaveBridge;
  const runBridge = {
    startRun: vi.fn<() => Promise<unknown>>(async () => ({ kind: "started", runId: "run-1" })),
    getRunState: vi.fn<() => Promise<unknown>>(async () => null),
    onRunState: vi.fn((listener: (value: unknown) => void) => {
      pushRun = listener;
      return () => {};
    }),
  } satisfies RunBridge;
  const bridge = {
    workspaceInfo: vi.fn<(workingFolder: unknown) => Promise<unknown>>(async (folder) =>
      (folder as { path?: string }).path === shop.path
        ? { kind: "branch", name: "fd-demo" }
        : { kind: "not-a-repo" },
    ),
  } satisfies Pick<FlowdeckBridge, "workspaceInfo">;

  const canvas = createCanvasStore({ ready: false });
  const save = createSaveStore({ bridge: saveBridge, canvas });
  const run = createRunStore({ bridge: runBridge, save, canvas });
  const workspace = createWorkspaceStore({ bridge, canvas, save, run });
  const label = () => selectWorkspaceLabel(workspace.getState());
  const runStarts = (runId: string) =>
    pushRun({ runId, status: "running", nodes: { "prompt-1": "waiting" } });

  return { bridge, canvas, save, run, workspace, label, runStarts, runBridge };
};

const loaded = async (options: Parameters<typeof setup>[0]) => {
  const parts = setup(options);
  await parts.save.getState().open();
  await parts.run.getState().connect();
  await settle();
  return parts;
};

describe("createWorkspaceStore", () => {
  it("shows nothing and asks nothing before the flow loads", () => {
    const { bridge, label } = setup();

    expect(label()).toBeNull();
    expect(bridge.workspaceInfo).not.toHaveBeenCalled();
  });

  it("asks for the loaded flow's folder and shows its name and branch", async () => {
    const { bridge, label } = await loaded({ latest: atFolder(shop) });

    expect(bridge.workspaceInfo).toHaveBeenCalledExactlyOnceWith(shop);
    expect(label()).toEqual({
      folder: { name: "shop", title: "/code/shop" },
      branch: "fd-demo",
    });
  });

  it("shows a new worktree's base branch for a flow that starts one", async () => {
    const { label } = await loaded({});

    expect(label()).toEqual({
      folder: { name: "repository not set", title: "" },
      branch: "new worktree from main",
    });
  });

  it("asks again when the working folder changes, without showing the old branch meanwhile", async () => {
    const { bridge, canvas, label } = await loaded({ latest: atFolder(shop) });
    const answer = deferred<unknown>();
    bridge.workspaceInfo.mockReturnValueOnce(answer.promise);

    canvas.getState().updateSession({ ...canvas.getState().flow.session, workingFolder: blog });

    expect(bridge.workspaceInfo).toHaveBeenLastCalledWith(blog);
    expect(label()).toEqual({ folder: { name: "blog", title: "/code/blog" }, branch: "" });

    answer.resolve({ kind: "not-a-repo" });
    await settle();

    expect(label()?.branch).toBe("not a git repo");
  });

  it("does not ask again for an edit that leaves the working folder alone", async () => {
    const { bridge, canvas } = await loaded({ latest: atFolder(shop) });

    canvas.getState().drop("script", { x: 300, y: 0 });
    await settle();

    expect(bridge.workspaceInfo).toHaveBeenCalledTimes(1);
  });

  it("asks again after a save", async () => {
    const { bridge, canvas, save } = await loaded({ latest: atFolder(shop) });
    canvas.getState().drop("script", { x: 300, y: 0 });

    await save.getState().save();
    await settle();

    expect(bridge.workspaceInfo).toHaveBeenCalledTimes(2);
    expect(bridge.workspaceInfo).toHaveBeenLastCalledWith(shop);
  });

  it("does not ask again after a save that fails", async () => {
    const { bridge, canvas, save } = await loaded({ latest: atFolder(shop), saveFails: true });
    canvas.getState().drop("script", { x: 300, y: 0 });

    await save.getState().save();
    await settle();

    expect(bridge.workspaceInfo).toHaveBeenCalledTimes(1);
  });

  it("asks again when a run starts, and not for later states of the same run", async () => {
    const { bridge, runStarts } = await loaded({ latest: atFolder(shop) });

    runStarts("run-1");
    runStarts("run-1");
    await settle();

    expect(bridge.workspaceInfo).toHaveBeenCalledTimes(2);
  });

  it("keeps the newest answer when an older one arrives late", async () => {
    const { bridge, canvas, label } = await loaded({ latest: atFolder(shop) });
    const late = deferred<unknown>();
    bridge.workspaceInfo.mockReturnValueOnce(late.promise);
    canvas.getState().updateSession({ ...canvas.getState().flow.session, workingFolder: blog });
    canvas.getState().updateSession({ ...canvas.getState().flow.session, workingFolder: shop });
    await settle();

    late.resolve({ kind: "missing" });
    await settle();

    expect(label()).toEqual({ folder: { name: "shop", title: "/code/shop" }, branch: "fd-demo" });
  });

  it.each([
    ["an answer that is not a folder state", async () => ({ kind: "sideways" })],
    ["a failed request", async () => Promise.reject(new Error("engine gone"))],
  ])("shows no branch for %s", async (_case, answer) => {
    const { bridge, canvas, label } = await loaded({ latest: atFolder(shop) });
    bridge.workspaceInfo.mockImplementationOnce(answer);

    canvas.getState().updateSession({ ...canvas.getState().flow.session, workingFolder: blog });
    await settle();

    expect(label()).toEqual({ folder: { name: "blog", title: "/code/blog" }, branch: "" });
  });
});
