import { describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { createActions, type ActionStores } from "../../../src/app/renderer/actions.js";
import { createNavStore } from "../../../src/app/renderer/nav-store.js";

const setup = (
  options: { flowId?: string | null; runId?: string | null; deleted?: boolean } = {},
) => {
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
});
