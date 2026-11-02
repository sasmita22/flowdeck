import { describe, expect, it } from "vitest";
import {
  appMenuItems,
  arrange,
  createNavStore,
  selectMenuItem,
} from "../../../src/app/renderer/nav-store.js";

describe("createNavStore", () => {
  it("starts in the editor", () => {
    expect(createNavStore().getState().page).toEqual({ name: "editor" });
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

    nav.getState().go({ name: "builds", hash: "abc123" });

    expect(nav.getState()).toMatchObject({ page: { name: "builds", hash: "abc123" }, query: "" });
    nav.getState().setQuery("x");
    nav.getState().go({ name: "builds", hash: "abc123" });
    expect(nav.getState().query).toBe("x");
  });

  it("opens search on the Blueprints page from the editor or a run, and stays on a list page", () => {
    const nav = createNavStore();

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

describe("selectMenuItem", () => {
  it("highlights the list a page belongs to", () => {
    expect(selectMenuItem({ name: "editor" })).toBe("blueprints");
    expect(selectMenuItem({ name: "blueprints" })).toBe("blueprints");
    expect(selectMenuItem({ name: "builds", hash: "abc" })).toBe("builds");
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
