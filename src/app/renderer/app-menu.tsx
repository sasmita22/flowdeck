import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { Actions } from "./actions.js";
import { Icon, type IconName } from "./icons.js";
import type { LibraryState } from "./library-store.js";
import { appMenuItems, selectMenuItem, type MenuItemId, type NavState } from "./nav-store.js";
import type { RunState } from "./run-store.js";
import { pageTestIds } from "./test-ids.js";

const menuIcons: Record<MenuItemId, IconName> = {
  blueprints: "blueprints",
  builds: "builds",
  runs: "runs",
  doctor: "doctor",
};

const recentCount = 5;

export function AppMenu({
  nav,
  library,
  run,
  actions,
}: {
  nav: StoreApi<NavState>;
  library: StoreApi<LibraryState>;
  run: StoreApi<RunState>;
  actions: Actions;
}) {
  const current = useStore(nav, (state) => selectMenuItem(state.page));
  const flows = useStore(library, (state) => state.flows);
  const live = useStore(run, (state) => state.snapshot?.status === "running");
  const recent = flows.filter((flow) => flow.versions > 0).slice(0, recentCount);
  return (
    <nav className="fd-app-menu" aria-label="App">
      <span className="fd-app-name" data-testid="app-title">
        Flowdeck
      </span>
      <button
        className="fd-menu-row"
        data-testid={pageTestIds.newBlueprint}
        onClick={() => void actions.newBlueprint()}
      >
        <Icon name="plus" />
        New blueprint
      </button>
      <button
        className="fd-menu-row"
        data-testid={pageTestIds.search}
        onClick={() => nav.getState().focusSearch()}
      >
        <Icon name="search" />
        Search
      </button>
      <div className="fd-menu-gap" />
      {appMenuItems.map((item) => (
        <button
          key={item.id}
          className="fd-menu-row"
          data-testid={item.testId}
          aria-current={current === item.id ? "page" : undefined}
          onClick={() => nav.getState().go({ name: item.id })}
        >
          <Icon name={menuIcons[item.id]} />
          {item.label}
          {item.id === "runs" && live && (
            <>
              <span className="fd-live-dot" title="A run is running" aria-hidden="true" />
              <span className="fd-visually-hidden">, 1 running</span>
            </>
          )}
        </button>
      ))}
      {recent.length > 0 && (
        <>
          <h2 className="fd-menu-heading">Recent blueprints</h2>
          {recent.map((flow) => (
            <button
              key={flow.flowId}
              className="fd-menu-row fd-menu-recent"
              data-testid={pageTestIds.recent(flow.flowId)}
              title={flow.name}
              onClick={() => void actions.openBlueprint(flow.flowId)}
            >
              <span className="fd-ellipsis">{flow.name}</span>
            </button>
          ))}
        </>
      )}
    </nav>
  );
}
