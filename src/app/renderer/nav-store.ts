import { createStore, type StoreApi } from "zustand/vanilla";

export type Page =
  | { name: "editor" }
  | { name: "blueprints" }
  | { name: "builds"; hash?: string }
  | { name: "runs" }
  | { name: "run"; runId: string }
  | { name: "doctor" };

export type MenuItemId = "blueprints" | "builds" | "runs" | "doctor";

export type Sort = "recent" | "name";

export type NavState = {
  page: Page;
  query: string;
  sort: Sort;
  searchFocus: number;
  go(page: Page): void;
  setQuery(query: string): void;
  setSort(sort: Sort): void;
  focusSearch(): void;
};

export const appMenuItems: readonly { id: MenuItemId; label: string; testId: string }[] = [
  { id: "blueprints", label: "Blueprints", testId: "menu-blueprints" },
  { id: "builds", label: "Builds", testId: "menu-builds" },
  { id: "runs", label: "Runs", testId: "menu-runs" },
  { id: "doctor", label: "Doctor", testId: "menu-doctor" },
];

export const selectMenuItem = (page: Page): MenuItemId => {
  switch (page.name) {
    case "editor":
    case "blueprints":
      return "blueprints";
    case "builds":
      return "builds";
    case "runs":
    case "run":
      return "runs";
    case "doctor":
      return "doctor";
  }
};

export const isListPage = (page: Page): boolean =>
  page.name === "blueprints" ||
  page.name === "runs" ||
  (page.name === "builds" && page.hash === undefined);

export function arrange<T>(
  items: readonly T[],
  { query, sort }: { query: string; sort: Sort },
  nameOf: (item: T) => string,
): T[] {
  const wanted = query.trim().toLowerCase();
  const found = items.filter((item) => nameOf(item).toLowerCase().includes(wanted));
  return sort === "name"
    ? found.sort((a, b) => nameOf(a).localeCompare(nameOf(b), "en", { sensitivity: "base" }))
    : found;
}

export const createNavStore = (): StoreApi<NavState> =>
  createStore<NavState>()((set, get) => ({
    page: { name: "editor" },
    query: "",
    sort: "recent",
    searchFocus: 0,
    go: (page) => {
      if (JSON.stringify(page) === JSON.stringify(get().page)) return;
      set({ page, query: "", sort: "recent" });
    },
    setQuery: (query) => set({ query }),
    setSort: (sort) => set({ sort }),
    focusSearch: () => {
      if (!isListPage(get().page)) get().go({ name: "blueprints" });
      set({ searchFocus: get().searchFocus + 1 });
    },
  }));
