import { describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { createActions, type ActionStores } from "../../../src/app/renderer/actions.js";
import { createNavStore } from "../../../src/app/renderer/nav-store.js";

const setup = (options: { flowId?: string | null; runId?: string | null } = {}) => {
  const nav = createNavStore();
  nav.getState().go({ name: "blueprints" });
  const save = createStore(() => ({
    flowId: options.flowId ?? null,
    open: vi.fn(async () => undefined),
    startNew: vi.fn(),
    leave: vi.fn(async (next: () => Promise<void>) => next()),
    rename: vi.fn(async () => undefined),
  }));
  const run = createStore(() => ({
    run: vi.fn(async () => options.runId ?? null),
    runBuild: vi.fn(async () => options.runId ?? null),
  }));
  const library = createStore(() => ({
    refresh: vi.fn(async () => undefined),
    rename: vi.fn(async () => true),
  }));
  const stores = { nav, save, run, library } satisfies ActionStores;
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

  it("opens the run page of a run that started, and refreshes the lists", async () => {
    const { actions, nav, library, run } = setup({ runId: "run-7" });

    await actions.buildAndRun();
    expect(nav.getState().page).toEqual({ name: "run", runId: "run-7" });

    nav.getState().go({ name: "builds" });
    await actions.runBuild("abc");
    expect(run.getState().runBuild).toHaveBeenCalledWith("abc");
    expect(nav.getState().page).toEqual({ name: "run", runId: "run-7" });
    expect(library.getState().refresh).toHaveBeenCalledTimes(2);
  });

  it("stays put when the run did not start", async () => {
    const { actions, nav } = setup({ runId: null });

    await actions.runBuild("abc");

    expect(nav.getState().page).toEqual({ name: "blueprints" });
  });

  it("renames the open blueprint through the editor, and any other one in the list", async () => {
    const { actions, save, library } = setup({ flowId: "flow-a" });

    await actions.renameBlueprint("flow-a", "Weekly");
    await actions.renameBlueprint("flow-b", "Daily");

    expect(save.getState().rename).toHaveBeenCalledExactlyOnceWith("Weekly");
    expect(library.getState().rename).toHaveBeenCalledExactlyOnceWith("flow-b", "Daily");
  });
});
