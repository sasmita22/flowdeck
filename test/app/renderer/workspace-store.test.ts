import { describe, expect, it, vi } from "vitest";
import type { FlowdeckBridge } from "../../../src/app/preload/bridge.js";
import { createCanvasStore } from "../../../src/app/renderer/canvas/store.js";
import { createSaveStore, type SaveBridge } from "../../../src/app/renderer/save-store.js";
import {
  buildTarget,
  createWorkspaceStore,
  selectWorkspaceLabel,
} from "../../../src/app/renderer/workspace-store.js";
import type { Flow } from "../../../src/core/flow/schema.js";
import {
  agent,
  flow,
  flowSettings,
  sessionContainer,
  sessionsWorkflow,
  twoSessionWorkflow,
  workspaceContainer,
} from "../../fixtures/flow-builders.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const shop = { repo: "/code/shop" };
const blog = { repo: "/code/blog" };

const atFolder = ({ repo }: { repo: string }): Flow =>
  flow([agent("agent-1")], [], flowSettings, { session: { repo } });

const moveTo = (canvas: ReturnType<typeof setup>["canvas"], { repo }: { repo: string }) =>
  canvas.getState().updateFlowContainer("session-1", { repo });

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

    expect(bridge.workspaceInfo).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(shop));
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

    moveTo(canvas, blog);

    expect(bridge.workspaceInfo).toHaveBeenLastCalledWith(expect.objectContaining(blog));
    expect(label()).toEqual({ folder: { name: "blog", title: "/code/blog" }, branch: "" });

    answer.resolve({ state: { kind: "not-a-repo" }, base: null });
    await settle();

    expect(label()?.branch).toBe("default branch");
  });

  it("does not ask again for an edit that leaves the repo and base alone", async () => {
    const { bridge, canvas } = await loaded({ latest: atFolder(shop) });

    canvas.getState().drop("gate", { x: 300, y: 0 });
    await settle();

    expect(bridge.workspaceInfo).toHaveBeenCalledTimes(1);
  });

  it("asks again after a save", async () => {
    const { bridge, canvas, save } = await loaded({ latest: atFolder(shop) });
    canvas.getState().drop("gate", { x: 300, y: 0 });

    await save.getState().save();
    await settle();

    expect(bridge.workspaceInfo).toHaveBeenCalledTimes(2);
    expect(bridge.workspaceInfo).toHaveBeenLastCalledWith(expect.objectContaining(shop));
  });

  it("does not ask again after a save that fails", async () => {
    const { bridge, canvas, save } = await loaded({ latest: atFolder(shop), saveFails: true });
    canvas.getState().drop("gate", { x: 300, y: 0 });

    await save.getState().save();
    await settle();

    expect(bridge.workspaceInfo).toHaveBeenCalledTimes(1);
  });

  it("keeps the newest answer when an older one arrives late", async () => {
    const { bridge, canvas, label } = await loaded({ latest: atFolder(shop) });
    const late = deferred<unknown>();
    bridge.workspaceInfo.mockReturnValueOnce(late.promise);
    moveTo(canvas, blog);
    moveTo(canvas, shop);
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

    moveTo(canvas, blog);
    await settle();

    expect(label()).toEqual({ folder: { name: "blog", title: "/code/blog" }, branch: "" });
  });

  it("shows the first session container's repo when the workflow has two", async () => {
    const { bridge, label } = await loaded({
      latest: flow([agent("a"), agent("b")], [], flowSettings, {
        containers: [
          workspaceContainer([]),
          sessionContainer(["a"], { repo: shop.repo }),
          sessionContainer(["b"], { id: "session-2", name: "web", repo: blog.repo }),
        ],
      }),
    });

    expect(bridge.workspaceInfo).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(shop));
    expect(label()?.folder).toEqual({ name: "shop", title: "/code/shop" });
  });
});

describe("buildTarget", () => {
  it("offers the repo and base override and the existing-branch choice for one session", () => {
    expect(buildTarget(atFolder(shop))).toMatchObject({ repoOverride: true, existingBranch: true });
  });

  it("hides the repo and base override, offers no existing branch, and names each session's repo and branch for two sessions", () => {
    expect(buildTarget(twoSessionWorkflow())).toEqual({
      repoOverride: false,
      existingBranch: false,
      branch: true,
      sessions: [
        { name: "android", repo: "/repos/android", branch: "main" },
        { name: "ios", repo: "/repos/ios", branch: "develop" },
      ],
    });
  });

  it("offers no repo, base or branch at all for a workspace with no session", () => {
    expect(buildTarget(sessionsWorkflow([]))).toEqual({
      repoOverride: false,
      existingBranch: false,
      branch: false,
      sessions: [],
    });
  });
});
