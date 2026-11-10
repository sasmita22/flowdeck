import { describe, expect, it, vi } from "vitest";
import {
  appMenuItems,
  arrange,
  createNavStore,
  isListPage,
  selectMenuItem,
  type Page,
} from "../../../src/app/renderer/nav-store.js";

describe("createNavStore", () => {
  it("starts on the Blueprints page", () => {
    expect(createNavStore().getState().page).toEqual({ name: "blueprints" });
  });

  it("goes to a page and clears the search and sort of the last one", () => {
    const nav = createNavStore();
    nav.getState().go({ name: "blueprints" });
    nav.getState().setQuery("report");
    nav.getState().setSort("name");

    nav.getState().go({ name: "runs" });

    expect(nav.getState()).toMatchObject({ page: { name: "runs" }, query: "", sort: "recent" });
  });

  it("clears the search for a build's page, and keeps it when going to the same page again", () => {
    const nav = createNavStore();
    nav.getState().go({ name: "builds" });
    nav.getState().setQuery("abc");

    nav.getState().go({ name: "builds", buildId: "b-0f3a9c2e" });

    expect(nav.getState()).toMatchObject({
      page: { name: "builds", buildId: "b-0f3a9c2e" },
      query: "",
    });
    nav.getState().setQuery("x");
    nav.getState().go({ name: "builds", buildId: "b-0f3a9c2e" });
    expect(nav.getState().query).toBe("x");
  });

  it("opens search on the Blueprints page from the editor or a run, and stays on a list page", () => {
    const nav = createNavStore();
    nav.getState().go({ name: "editor" });

    nav.getState().focusSearch();
    expect(nav.getState().page).toEqual({ name: "blueprints" });
    expect(nav.getState().searchFocus).toBe(1);

    nav.getState().go({ name: "runs" });
    nav.getState().focusSearch();
    expect(nav.getState().page).toEqual({ name: "runs" });
    expect(nav.getState().searchFocus).toBe(2);

    nav.getState().go({ name: "run", runId: "run-1" });
    nav.getState().focusSearch();
    expect(nav.getState().page).toEqual({ name: "blueprints" });
  });
});

describe("leaving the editor", () => {
  const holdingGuard = () => {
    const held: (() => Promise<void>)[] = [];
    const leave = vi.fn(async (next: () => Promise<void>) => {
      held.push(next);
    });
    return { leave, held };
  };

  const onEditor = (leave?: (next: () => Promise<void>) => Promise<void>) => {
    const nav = leave === undefined ? createNavStore() : createNavStore({ leave });
    nav.getState().go({ name: "editor" });
    return nav;
  };

  it("changes the page at once when the guard lets it through", () => {
    const leave = vi.fn(async (next: () => Promise<void>) => {
      await next();
    });
    const nav = onEditor(leave);

    nav.getState().go({ name: "blueprints" });

    expect(leave).toHaveBeenCalledTimes(1);
    expect(nav.getState().page).toEqual({ name: "blueprints" });
  });

  it("stays on the editor while the guard holds, and moves once the guard goes on", async () => {
    const { leave, held } = holdingGuard();
    const nav = onEditor(leave);

    nav.getState().go({ name: "blueprints" });

    expect(leave).toHaveBeenCalledTimes(1);
    expect(nav.getState().page).toEqual({ name: "editor" });

    await held[0]?.();

    expect(nav.getState().page).toEqual({ name: "blueprints" });
  });

  it.each<Page>([
    { name: "blueprints" },
    { name: "builds", buildId: "b-0f3a9c2e" },
    { name: "run", runId: "run-1" },
  ])("asks the guard before going to $name", (target) => {
    const { leave } = holdingGuard();
    const nav = onEditor(leave);

    nav.getState().go(target);

    expect(leave).toHaveBeenCalledTimes(1);
    expect(nav.getState().page).toEqual({ name: "editor" });
  });

  it("asks the guard when search sends the editor to the Blueprints page", () => {
    const { leave } = holdingGuard();
    const nav = onEditor(leave);

    nav.getState().focusSearch();

    expect(leave).toHaveBeenCalledTimes(1);
    expect(nav.getState().page).toEqual({ name: "editor" });
  });

  it("does not ask the guard when going to the editor it is already on", () => {
    const { leave } = holdingGuard();
    const nav = onEditor(leave);

    nav.getState().go({ name: "editor" });

    expect(leave).not.toHaveBeenCalled();
    expect(nav.getState().page).toEqual({ name: "editor" });
  });

  it("does not ask the guard between two pages that are not the editor", () => {
    const { leave } = holdingGuard();
    const nav = createNavStore({ leave });

    nav.getState().go({ name: "builds" });

    expect(leave).not.toHaveBeenCalled();
    expect(nav.getState().page).toEqual({ name: "builds" });
  });

  it("leaves the editor at once when no guard is given", () => {
    const nav = onEditor();

    nav.getState().go({ name: "blueprints" });

    expect(nav.getState().page).toEqual({ name: "blueprints" });
  });
});

describe("isListPage", () => {
  it("is true for the Builds list and false for one build's page, named by its id", () => {
    expect(isListPage({ name: "builds" })).toBe(true);
    expect(isListPage({ name: "builds", buildId: "b-0f3a9c2e" })).toBe(false);
  });

  it("opens search on the Builds list, not on one build's page", () => {
    const nav = createNavStore();
    nav.getState().go({ name: "builds", buildId: "b-0f3a9c2e" });

    nav.getState().focusSearch();

    expect(nav.getState().page).toEqual({ name: "blueprints" });
  });
});

describe("selectMenuItem", () => {
  it("highlights the list a page belongs to", () => {
    expect(selectMenuItem({ name: "editor" })).toBe("blueprints");
    expect(selectMenuItem({ name: "blueprints" })).toBe("blueprints");
    expect(selectMenuItem({ name: "builds", buildId: "b-1" })).toBe("builds");
    expect(selectMenuItem({ name: "run", runId: "r" })).toBe("runs");
    expect(selectMenuItem({ name: "doctor" })).toBe("doctor");
  });

  it("lists the menu in order, each with a test id", () => {
    expect(appMenuItems.map(({ id, label, testId }) => [id, label, testId])).toEqual([
      ["blueprints", "Blueprints", "menu-blueprints"],
      ["builds", "Builds", "menu-builds"],
      ["runs", "Runs", "menu-runs"],
      ["doctor", "Doctor", "menu-doctor"],
    ]);
  });
});

describe("arrange", () => {
  const items = [
    { name: "Triage", at: "2026-01-02" },
    { name: "alpha report", at: "2026-01-03" },
    { name: "Weekly Report", at: "2026-01-01" },
  ];
  const nameOf = (item: (typeof items)[number]) => item.name;

  it("keeps the given order by recent, and sorts by name ignoring case", () => {
    expect(arrange(items, { query: "", sort: "recent" }, nameOf).map((item) => item.name)).toEqual([
      "Triage",
      "alpha report",
      "Weekly Report",
    ]);
    expect(arrange(items, { query: "", sort: "name" }, nameOf).map((item) => item.name)).toEqual([
      "alpha report",
      "Triage",
      "Weekly Report",
    ]);
  });

  it("filters by the search in the name, ignoring case and spaces around it", () => {
    expect(
      arrange(items, { query: "  REPORT ", sort: "recent" }, nameOf).map((item) => item.name),
    ).toEqual(["alpha report", "Weekly Report"]);
  });
});
