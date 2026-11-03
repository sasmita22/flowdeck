import { describe, expect, it, vi } from "vitest";
import type { FlowdeckBridge } from "../../../src/app/preload/bridge.js";
import { createCanvasStore } from "../../../src/app/renderer/canvas/store.js";
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

const shop = { repo: "/code/shop", variables: [] };
const blog = { repo: "/code/blog", variables: [] };

const atFolder = (buildConfig: Flow["session"]["buildConfig"]): Flow => {
  const base = flow([prompt("prompt-1")], []);
  return { ...base, session: { ...base.session, buildConfig } };
};

const setup = (options: { latest?: Flow; saveFails?: boolean } = {}) => {
  const saveBridge = {
    saveFlow: vi.fn<(flow: unknown) => Promise<unknown>>(async () =>
      options.saveFails === true
        ? { kind: "error", message: "disk full" }
        : { kind: "saved", flowId: "flow-1", version: 1 },
    ),
    openFlow: vi.fn<(payload: { flowId?: string }) => Promise<unknown>>(async () =>
      options.latest === undefined
        ? null
        : { flowId: "flow-1", name: "Untitled", version: 1, flow: options.latest },
    ),
    renameFlow: vi.fn<(payload: { flowId: string; name: string }) => Promise<unknown>>(
      async () => null,
    ),
    setDirty: vi.fn<(dirty: boolean) => void>(),
    onCloseRequest: vi.fn(() => () => {}),
    answerClose: vi.fn<(answer: "close" | "cancel") => void>(),
  } satisfies SaveBridge;
  const bridge = {
    workspaceInfo: vi.fn<(buildConfig: unknown) => Promise<unknown>>(async (folder) =>
      (folder as { repo?: string }).repo === undefined
        ? null
        : (folder as { repo?: string }).repo === shop.repo
          ? { state: { kind: "branch", name: "fd-demo" }, base: "main" }
          : { state: { kind: "not-a-repo" }, base: null },
    ),
  } satisfies Pick<FlowdeckBridge, "workspaceInfo">;

  const canvas = createCanvasStore({ ready: false });
  const save = createSaveStore({ bridge: saveBridge, canvas });
  const workspace = createWorkspaceStore({ bridge, canvas, save });
  const label = () => selectWorkspaceLabel(workspace.getState());

  return { bridge, canvas, save, workspace, label };
};

const loaded = async (options: Parameters<typeof setup>[0]) => {
  const parts = setup(options);
  await parts.save.getState().open();
  await settle();
  return parts;
};

describe("createWorkspaceStore", () => {
  it("shows nothing and asks nothing before the flow loads", () => {
    const { bridge, label } = setup();

    expect(label()).toBeNull();
    expect(bridge.workspaceInfo).not.toHaveBeenCalled();
  });

  it("asks for the loaded flow's repo and shows its folder name and base branch", async () => {
    const { bridge, label } = await loaded({ latest: atFolder(shop) });

    expect(bridge.workspaceInfo).toHaveBeenCalledExactlyOnceWith(shop);
    expect(label()).toEqual({
      folder: { name: "shop", title: "/code/shop" },
      branch: "main",
    });
  });

  it("says the repo is not set for a new blueprint, which starts from the default branch", async () => {
    const { label } = await loaded({});

    expect(label()).toEqual({
      folder: { name: "repo not set", title: "" },
      branch: "default branch",
    });
  });

  it("asks again when the repo changes, without showing the old base branch meanwhile", async () => {
    const { bridge, canvas, label } = await loaded({ latest: atFolder(shop) });
    const answer = deferred<unknown>();
    bridge.workspaceInfo.mockReturnValueOnce(answer.promise);

    canvas.getState().updateSession({ ...canvas.getState().flow.session, buildConfig: blog });

    expect(bridge.workspaceInfo).toHaveBeenLastCalledWith(blog);
    expect(label()).toEqual({ folder: { name: "blog", title: "/code/blog" }, branch: "" });

    answer.resolve({ state: { kind: "not-a-repo" }, base: null });
    await settle();

    expect(label()?.branch).toBe("default branch");
  });

  it("does not ask again for an edit that leaves the repo and base alone", async () => {
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

  it("keeps the newest answer when an older one arrives late", async () => {
    const { bridge, canvas, label } = await loaded({ latest: atFolder(shop) });
    const late = deferred<unknown>();
    bridge.workspaceInfo.mockReturnValueOnce(late.promise);
    canvas.getState().updateSession({ ...canvas.getState().flow.session, buildConfig: blog });
    canvas.getState().updateSession({ ...canvas.getState().flow.session, buildConfig: shop });
    await settle();

    late.resolve({ state: { kind: "missing" }, base: "stale" });
    await settle();

    expect(label()).toEqual({ folder: { name: "shop", title: "/code/shop" }, branch: "main" });
  });

  it.each([
    ["an answer that is not a workspace state", async () => ({ state: { kind: "sideways" } })],
    ["a failed request", async () => Promise.reject(new Error("engine gone"))],
  ])("shows no branch for %s", async (_case, answer) => {
    const { bridge, canvas, label } = await loaded({ latest: atFolder(shop) });
    bridge.workspaceInfo.mockImplementationOnce(answer);

    canvas.getState().updateSession({ ...canvas.getState().flow.session, buildConfig: blog });
    await settle();

    expect(label()).toEqual({ folder: { name: "blog", title: "/code/blog" }, branch: "" });
  });
});
