import { useState, type KeyboardEvent } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { FlowSummary } from "../../../core/flow/flow-store.js";
import type { Actions } from "../actions.js";
import type { BuildProgressState } from "../build-progress-store.js";
import { folderText, formatWhen } from "../format.js";
import { Icon } from "../icons.js";
import type { LibraryState } from "../library-store.js";
import { arrange, type NavState } from "../nav-store.js";
import type { RunState } from "../run-store.js";
import { pageTestIds } from "../test-ids.js";
import { Empty, PageHead } from "./page-head.js";

const versionsText = (count: number) => (count === 1 ? "1 version" : `${count} versions`);

function BuildChip({
  flowId,
  buildProgress,
}: {
  flowId: string;
  buildProgress: StoreApi<BuildProgressState>;
}) {
  const chip = useStore(buildProgress, (state) => state.chipFor(flowId));
  const building = useStore(buildProgress, (state) => state.isBuilding(flowId));
  if (chip === undefined) return null;
  return (
    <span
      className={`fd-badge ${building ? "fd-badge-live" : "fd-badge-quiet"}`}
      data-testid={pageTestIds.buildChip(flowId)}
    >
      {chip}
    </span>
  );
}

function BlueprintCard({
  flow,
  run,
  buildProgress,
  actions,
}: {
  flow: FlowSummary;
  run: StoreApi<RunState>;
  buildProgress: StoreApi<BuildProgressState>;
  actions: Actions;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const busy = useStore(run, (state) => state.starting);

  const commit = async () => {
    if (draft === null) return;
    const name = draft;
    setDraft(null);
    if (name.trim() !== "" && name.trim() !== flow.name) {
      await actions.renameBlueprint(flow.flowId, name);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") void commit();
    if (event.key === "Escape") setDraft(null);
  };

  const build = () =>
    run.getState().openBuild({
      flowId: flow.flowId,
      version: flow.versions,
      buildConfig: flow.buildConfig ?? { variables: [] },
    });

  return (
    <article className="fd-card" data-testid={pageTestIds.blueprintCard(flow.flowId)}>
      <div className="fd-card-top">
        {draft === null ? (
          <button
            className="fd-card-name"
            data-testid={pageTestIds.blueprintOpen(flow.flowId)}
            title={`Open ${flow.name}`}
            onClick={() => void actions.openBlueprint(flow.flowId)}
          >
            {flow.name}
          </button>
        ) : (
          <input
            className="fd-card-name-input"
            data-testid={pageTestIds.blueprintNameInput(flow.flowId)}
            aria-label="Blueprint name"
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => void commit()}
          />
        )}
        <button
          className="fd-btn fd-icon-btn fd-quiet"
          data-testid={pageTestIds.blueprintRename(flow.flowId)}
          title="Rename"
          aria-label={`Rename ${flow.name}`}
          onClick={() => setDraft(flow.name)}
        >
          <Icon name="pencil" />
        </button>
        <BuildChip flowId={flow.flowId} buildProgress={buildProgress} />
      </div>
      <div className="fd-card-meta">
        <span>{flow.lastSavedAt === null ? "Never saved" : formatWhen(flow.lastSavedAt)}</span>
        <span>{versionsText(flow.versions)}</span>
        <span className="fd-card-place" title={folderText(flow.buildConfig)}>
          <Icon name="folder" />
          <span className="fd-ellipsis">{folderText(flow.buildConfig)}</span>
        </span>
      </div>
      <div className="fd-card-actions">
        <button
          className="fd-btn"
          data-testid={pageTestIds.blueprintBuild(flow.flowId)}
          disabled={flow.versions === 0 || busy}
          title={flow.versions === 0 ? "Save it first, then build" : "Build the latest version"}
          onClick={() => void build()}
        >
          Build v{Math.max(flow.versions, 1)}
        </button>
      </div>
    </article>
  );
}

export function BlueprintsPage({
  nav,
  library,
  run,
  buildProgress,
  actions,
}: {
  nav: StoreApi<NavState>;
  library: StoreApi<LibraryState>;
  run: StoreApi<RunState>;
  buildProgress: StoreApi<BuildProgressState>;
  actions: Actions;
}) {
  const flows = useStore(library, (state) => state.flows);
  const loaded = useStore(library, (state) => state.loaded);
  const query = useStore(nav, (state) => state.query);
  const sort = useStore(nav, (state) => state.sort);
  const shown = arrange(flows, { query, sort }, (flow) => flow.name);
  return (
    <>
      <PageHead
        title="Blueprints"
        nav={nav}
        searchLabel="Search blueprints"
        action={
          <button
            className="fd-btn fd-btn-primary"
            data-testid={pageTestIds.create}
            onClick={() => void actions.newBlueprint()}
          >
            New blueprint
          </button>
        }
      />
      {loaded && flows.length === 0 && (
        <Empty>No blueprints yet. Start one with New blueprint, draw it, then save.</Empty>
      )}
      {flows.length > 0 && shown.length === 0 && <Empty>No blueprint matches “{query}”.</Empty>}
      <div className="fd-cards">
        {shown.map((flow) => (
          <BlueprintCard
            key={flow.flowId}
            flow={flow}
            run={run}
            buildProgress={buildProgress}
            actions={actions}
          />
        ))}
      </div>
    </>
  );
}
