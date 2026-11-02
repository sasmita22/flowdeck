import { useEffect, useRef, type ReactNode } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { Icon } from "../icons.js";
import type { NavState, Sort } from "../nav-store.js";
import { pageTestIds } from "../test-ids.js";

export function PageHead({
  title,
  nav,
  searchLabel,
  tabs,
  action,
}: {
  title: string;
  nav: StoreApi<NavState>;
  searchLabel?: string;
  tabs?: ReactNode;
  action?: ReactNode;
}) {
  const query = useStore(nav, (state) => state.query);
  const sort = useStore(nav, (state) => state.sort);
  const searchFocus = useStore(nav, (state) => state.searchFocus);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchFocus > 0) search.current?.focus();
  }, [searchFocus]);

  return (
    <header className="fd-page-head">
      <h1 className="fd-page-title" data-testid={pageTestIds.title}>
        {title}
      </h1>
      {(tabs !== undefined || searchLabel !== undefined) && (
        <div className="fd-page-bar">
          <div className="fd-tabs">{tabs}</div>
          {searchLabel !== undefined && (
            <div className="fd-page-tools">
              <label className="fd-search-box">
                <Icon name="search" />
                <input
                  ref={search}
                  type="search"
                  data-testid={pageTestIds.query}
                  aria-label={searchLabel}
                  placeholder={searchLabel}
                  value={query}
                  onChange={(event) => nav.getState().setQuery(event.target.value)}
                />
              </label>
              <select
                className="fd-select"
                data-testid={pageTestIds.sort}
                aria-label="Sort"
                value={sort}
                onChange={(event) => nav.getState().setSort(event.target.value as Sort)}
              >
                <option value="recent">Newest first</option>
                <option value="name">By name</option>
              </select>
              {action}
            </div>
          )}
        </div>
      )}
    </header>
  );
}

export function WithCode({ text }: { text: string }) {
  return text
    .split("`")
    .map((part, index) => (index % 2 === 1 ? <code key={index}>{part}</code> : part));
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="fd-empty">{children}</p>;
}
