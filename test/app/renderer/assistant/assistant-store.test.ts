import { describe, expect, it, vi } from "vitest";
import type { FlowdeckBridge } from "../../../../src/app/preload/bridge.js";
import { createAssistantStore } from "../../../../src/app/renderer/assistant/assistant-store.js";
import { createCanvasStore } from "../../../../src/app/renderer/canvas/store.js";
import { createSaveStore } from "../../../../src/app/renderer/save-store.js";
import { flow, prompt } from "../../../fixtures/flow-builders.js";

type SaveReply =
  { kind: "saved"; flowId: string; version: number } | { kind: "error"; message: string };

const setup = async (options: { saved?: boolean; saveReply?: SaveReply } = {}) => {
  const saveBridge = {
    saveFlow: vi.fn<(payload: unknown) => Promise<unknown>>(
      async () => options.saveReply ?? { kind: "saved", flowId: "flow-new", version: 1 },
    ),
    openFlow: vi.fn<(payload: { flowId?: string }) => Promise<unknown>>(async () =>
      options.saved === false
        ? null
        : { flowId: "flow-1", name: "Weekly", version: 1, flow: flow([prompt("p1")], []) },
    ),
    renameFlow: vi.fn<(payload: { flowId: string; name: string }) => Promise<unknown>>(
      async () => null,
    ),
    setDirty: vi.fn<(dirty: boolean) => void>(),
    onCloseRequest: vi.fn(() => () => {}),
    answerClose: vi.fn<(answer: "close" | "cancel") => void>(),
  } satisfies Pick<
    FlowdeckBridge,
    "saveFlow" | "openFlow" | "renameFlow" | "setDirty" | "onCloseRequest" | "answerClose"
  >;
  const bridge = {
    startBlueprintSession: vi.fn<(payload: { flowId: string }) => Promise<unknown>>(
      async ({ flowId }) => ({ session: `fd-bp-${flowId}` }),
    ),
    stopBlueprintSession: vi.fn<(payload: { flowId: string }) => Promise<unknown>>(
      async () => null,
    ),
  } satisfies Pick<FlowdeckBridge, "startBlueprintSession" | "stopBlueprintSession">;
  const canvas = createCanvasStore({ ready: false });
  const save = createSaveStore({ bridge: saveBridge, canvas });
  await save.getState().open();
  const assistant = createAssistantStore({ bridge, save });
  return { assistant, bridge, saveBridge, save };
};

describe("createAssistantStore", () => {
  it("starts hidden, with no session", async () => {
    const { assistant } = await setup();

    expect(assistant.getState()).toMatchObject({ visible: false, session: null });
  });

  it("starts one session for the open saved blueprint when shown", async () => {
    const { assistant, bridge } = await setup();

    await assistant.getState().show();

    expect(bridge.startBlueprintSession).toHaveBeenCalledExactlyOnceWith({ flowId: "flow-1" });
    expect(assistant.getState()).toMatchObject({
      visible: true,
      flowId: "flow-1",
      session: "fd-bp-flow-1",
    });
  });

  it("reuses the live session when hidden and shown again", async () => {
    const { assistant, bridge } = await setup();

    await assistant.getState().show();
    assistant.getState().hide();

    expect(assistant.getState()).toMatchObject({ visible: false, session: "fd-bp-flow-1" });

    await assistant.getState().show();

    expect(bridge.startBlueprintSession).toHaveBeenCalledTimes(1);
    expect(assistant.getState()).toMatchObject({ visible: true, session: "fd-bp-flow-1" });
  });

  it("saves a never-saved blueprint first, then starts the session with its new flow id", async () => {
    const { assistant, bridge, saveBridge, save } = await setup({ saved: false });
    expect(save.getState().flowId).toBeNull();

    await assistant.getState().show();

    expect(saveBridge.saveFlow).toHaveBeenCalledTimes(1);
    expect(save.getState().flowId).toBe("flow-new");
    expect(bridge.startBlueprintSession).toHaveBeenCalledExactlyOnceWith({ flowId: "flow-new" });
    expect(saveBridge.saveFlow.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.startBlueprintSession.mock.invocationCallOrder[0] ?? 0,
    );
    expect(assistant.getState()).toMatchObject({ flowId: "flow-new", session: "fd-bp-flow-new" });
  });

  it("starts nothing when saving a never-saved blueprint fails", async () => {
    const { assistant, bridge } = await setup({
      saved: false,
      saveReply: { kind: "error", message: "disk full" },
    });

    await assistant.getState().show();

    expect(bridge.startBlueprintSession).not.toHaveBeenCalled();
    expect(assistant.getState().session).toBeNull();
  });

  it("ends the live session: stops it by flow id and clears the session and the pane", async () => {
    const { assistant, bridge } = await setup();
    await assistant.getState().show();

    await assistant.getState().end();

    expect(bridge.stopBlueprintSession).toHaveBeenCalledExactlyOnceWith({ flowId: "flow-1" });
    expect(assistant.getState()).toMatchObject({ visible: false, session: null });
  });

  it("makes no call when ending with no session", async () => {
    const { assistant, bridge } = await setup();

    await assistant.getState().end();

    expect(bridge.stopBlueprintSession).not.toHaveBeenCalled();
  });
});
