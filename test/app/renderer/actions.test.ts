import { describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { createActions, type ActionStores } from "../../../src/app/renderer/actions.js";
import { createCanvasStore } from "../../../src/app/renderer/canvas/store.js";
import { createNavStore } from "../../../src/app/renderer/nav-store.js";
import { createSaveStore } from "../../../src/app/renderer/save-store.js";

const setup = (
  options: {
    flowId?: string | null;
    runId?: string | null;
    deleted?: boolean;
    leaveAnswer?: "proceed" | "cancel";
    deleteRefused?: boolean;
  } = {},
) => {
  const nav = createNavStore();
  nav.getState().go({ name: "blueprints" });
  const save = createStore(() => ({
    flowId: options.flowId ?? null,
    error: null,
    open: vi.fn(async () => undefined),
    startNew: vi.fn(),
    leave: vi.fn(async (next: () => Promise<void>) => {
      if (options.leaveAnswer === "cancel") return;
      await next();
    }),
    rename: vi.fn(async () => undefined),
  }));
  const run = createStore(() => ({
    runBuild: vi.fn<(buildId: string) => Promise<string | null>>(async () => options.runId ?? null),
    start: vi.fn<(choice: { auto: boolean }) => Promise<string | null>>(
      async () => options.runId ?? null,
    ),
    deleteBuild: vi.fn<(buildId: string) => Promise<boolean>>(async () => options.deleted ?? true),
    stop: vi.fn<(runId: string) => Promise<void>>(async () => undefined),
  }));
  const library = createStore(() => ({
    refresh: vi.fn(async () => undefined),
    rename: vi.fn(async () => true),
    delete: vi.fn(async () => !(options.deleteRefused ?? false)),
  }));
  const assistant = createStore(() => ({ end: vi.fn(async () => undefined) }));
  const stores = { nav, save, run, library, assistant } satisfies ActionStores;
  return { ...stores, actions: createActions(stores) };
};

describe("createActions", () => {
  it("opens another blueprint in the editor once unsaved changes are settled", async () => {
    const { actions, nav, save } = setup({ flowId: "flow-a" });

    await actions.openBlueprint("flow-b");

    expect(save.getState().leave).toHaveBeenCalledTimes(1);
    expect(save.getState().open).toHaveBeenCalledWith("flow-b");
    expect(nav.getState().page).toEqual({ name: "editor" });
  });

  it("goes back to the open blueprint without reloading it", async () => {
    const { actions, nav, save } = setup({ flowId: "flow-a" });

    await actions.openBlueprint("flow-a");

    expect(save.getState().leave).not.toHaveBeenCalled();
    expect(save.getState().open).not.toHaveBeenCalled();
    expect(nav.getState().page).toEqual({ name: "editor" });
  });

  it("starts a new blueprint in the editor", async () => {
    const { actions, nav, save } = setup();

    await actions.newBlueprint();

    expect(save.getState().startNew).toHaveBeenCalledTimes(1);
    expect(nav.getState().page).toEqual({ name: "editor" });
  });

  it("ends the blueprint session when the user proceeds to open another blueprint", async () => {
    const { actions, assistant } = setup({ flowId: "flow-a" });

    await actions.openBlueprint("flow-b");

    expect(assistant.getState().end).toHaveBeenCalledTimes(1);
  });

  it("keeps the blueprint session when the user cancels opening another blueprint", async () => {
    const { actions, assistant, save } = setup({ flowId: "flow-a", leaveAnswer: "cancel" });

    await actions.openBlueprint("flow-b");

    expect(save.getState().open).not.toHaveBeenCalled();
    expect(assistant.getState().end).not.toHaveBeenCalled();
  });

  it("keeps the blueprint session when the open blueprint is opened again", async () => {
    const { actions, assistant } = setup({ flowId: "flow-a" });

    await actions.openBlueprint("flow-a");

    expect(assistant.getState().end).not.toHaveBeenCalled();
  });

  it("ends the blueprint session when the user starts a new blueprint", async () => {
    const { actions, assistant } = setup({ flowId: "flow-a" });

    await actions.newBlueprint();

    expect(assistant.getState().end).toHaveBeenCalledTimes(1);
  });

  it("runs a build by its id, opens the run page of the run that started, and refreshes the lists", async () => {
    const { actions, nav, library, run } = setup({ runId: "run-7" });
    nav.getState().go({ name: "builds" });

    await actions.runBuild("b-0f3a9c2e");

    expect(run.getState().runBuild).toHaveBeenCalledWith("b-0f3a9c2e");
    expect(nav.getState().page).toEqual({ name: "run", runId: "run-7" });
    expect(library.getState().refresh).toHaveBeenCalledTimes(1);
  });

  it("opens the run page once the run dialog starts a run with its auto choice", async () => {
    const { actions, nav, run } = setup({ runId: "run-8" });

    await actions.startRun({ auto: true });

    expect(run.getState().start).toHaveBeenCalledWith({ auto: true });
    expect(nav.getState().page).toEqual({ name: "run", runId: "run-8" });
  });

  it("stays put when the run did not start", async () => {
    const { actions, nav } = setup({ runId: null });

    await actions.runBuild("b-0f3a9c2e");

    expect(nav.getState().page).toEqual({ name: "blueprints" });
  });

  it("deletes a build by its id and refreshes the lists, staying on the page", async () => {
    const { actions, nav, library, run } = setup();
    nav.getState().go({ name: "builds" });

    await actions.deleteBuild("b-0f3a9c2e");

    expect(run.getState().deleteBuild).toHaveBeenCalledWith("b-0f3a9c2e");
    expect(library.getState().refresh).toHaveBeenCalledTimes(1);
    expect(nav.getState().page).toEqual({ name: "builds" });
  });

  it("refreshes the lists after a refused delete too, so the card shows what is true", async () => {
    const { actions, library } = setup({ deleted: false });

    await actions.deleteBuild("b-0f3a9c2e");

    expect(library.getState().refresh).toHaveBeenCalledTimes(1);
  });

  it("stops a run by its id and refreshes the lists, staying on the page", async () => {
    const { actions, nav, library, run } = setup();
    nav.getState().go({ name: "builds" });

    await actions.stopRun("run-7");

    expect(run.getState().stop).toHaveBeenCalledWith("run-7");
    expect(library.getState().refresh).toHaveBeenCalledTimes(1);
    expect(nav.getState().page).toEqual({ name: "builds" });
  });

  it("renames the open blueprint through the editor, and any other one in the list", async () => {
    const { actions, save, library } = setup({ flowId: "flow-a" });

    await actions.renameBlueprint("flow-a", "Weekly");
    await actions.renameBlueprint("flow-b", "Daily");

    expect(save.getState().rename).toHaveBeenCalledExactlyOnceWith("Weekly");
    expect(library.getState().rename).toHaveBeenCalledExactlyOnceWith("flow-b", "Daily");
  });

  it("deletes the blueprint the editor holds by deleting it, ending its pane, then starting a new one", async () => {
    const { actions, assistant, library, save } = setup({ flowId: "flow-a" });

    await actions.deleteBlueprint("flow-a");

    const ended = assistant.getState().end.mock.invocationCallOrder[0] ?? 0;
    const deleted = library.getState().delete.mock.invocationCallOrder[0] ?? 0;
    const started = save.getState().startNew.mock.invocationCallOrder[0] ?? 0;
    expect(library.getState().delete).toHaveBeenCalledExactlyOnceWith("flow-a");
    expect(deleted).toBeGreaterThan(0);
    expect(deleted).toBeLessThan(ended);
    expect(ended).toBeLessThan(started);
  });

  it("keeps the editor and its pane when the delete of the held blueprint is refused", async () => {
    const { actions, assistant, library, save } = setup({ flowId: "flow-a", deleteRefused: true });

    await actions.deleteBlueprint("flow-a");

    expect(library.getState().delete).toHaveBeenCalledExactlyOnceWith("flow-a");
    expect(assistant.getState().end).not.toHaveBeenCalled();
    expect(save.getState().startNew).not.toHaveBeenCalled();
  });

  it("deletes a blueprint the editor does not hold without touching the editor or its pane", async () => {
    const { actions, assistant, library, save, nav } = setup({ flowId: "flow-a" });

    await actions.deleteBlueprint("flow-b");

    expect(library.getState().delete).toHaveBeenCalledExactlyOnceWith("flow-b");
    expect(assistant.getState().end).not.toHaveBeenCalled();
    expect(save.getState().startNew).not.toHaveBeenCalled();
    expect(nav.getState().page).toEqual({ name: "blueprints" });
  });
});

describe("opening a blueprint through the editor's save store", () => {
  const withOpenFlow = (openFlow: (payload: { flowId?: string }) => Promise<unknown>) => {
    const nav = createNavStore();
    nav.getState().go({ name: "run", runId: "run-1" });
    const bridge = {
      saveFlow: vi.fn(async () => ({ kind: "saved", flowId: "flow-1", version: 1 })),
      openFlow: vi.fn(openFlow),
      renameFlow: vi.fn(async () => null),
      setDirty: vi.fn(),
      onCloseRequest: vi.fn(() => () => {}),
      answerClose: vi.fn(),
    };
    const save = createSaveStore({ bridge, canvas: createCanvasStore({ ready: false }) });
    const run = createStore(() => ({
      runBuild: vi.fn(async () => null),
      start: vi.fn(async () => null),
      deleteBuild: vi.fn(async () => true),
      stop: vi.fn(async () => undefined),
    }));
    const library = createStore(() => ({
      refresh: vi.fn(async () => undefined),
      rename: vi.fn(async () => true),
      delete: vi.fn(async () => true),
    }));
    const assistant = createStore(() => ({ end: vi.fn(async () => undefined) }));
    return { nav, actions: createActions({ nav, save, run, library, assistant }) };
  };

  it("stays on the page and rejects with the engine's answer when the blueprint was deleted", async () => {
    const { actions, nav } = withOpenFlow(async () => {
      throw new Error("Blueprint flow-a was deleted");
    });

    await expect(actions.openBlueprint("flow-a")).rejects.toThrow("Blueprint flow-a was deleted");
    expect(nav.getState().page).toEqual({ name: "run", runId: "run-1" });
  });

  it("opens the editor when the blueprint opens", async () => {
    const { actions, nav } = withOpenFlow(async () => ({
      flowId: "flow-a",
      name: "Report",
      version: null,
      flow: null,
    }));

    await actions.openBlueprint("flow-a");

    expect(nav.getState().page).toEqual({ name: "editor" });
  });
});
