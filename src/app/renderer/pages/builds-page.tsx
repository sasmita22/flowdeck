import { useEffect, useMemo } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { BuildingCard, BuildOutcome } from "../../../core/run/build-progress.js";
import type { Actions } from "../actions.js";
import { selectBuildingCards, type BuildProgressState } from "../build-progress-store.js";
import { formatWhen } from "../format.js";
import { Icon } from "../icons.js";
import { selectBuildCards, type BuildCard, type LibraryState } from "../library-store.js";
import { arrange, type NavState } from "../nav-store.js";
import { selectKeptNote, selectRunDisabled, selectRunHint, type RunState } from "../run-store.js";
import { pageTestIds } from "../test-ids.js";
import { BlueprintPicture } from "./blueprint-picture.js";
import { Empty, PageHead } from "./page-head.js";

const versionText = (card: Pick<BuildCard, "version">) =>
  card.version === null ? "" : `v${card.version}`;

const neverRun = { old: false, run: null };

function useRunDisabled(run: StoreApi<RunState>, card: BuildCard | undefined) {
  return useStore(run, (state) => selectRunDisabled(state, card ?? neverRun));
}

function useCards(library: StoreApi<LibraryState>) {
  const builds = useStore(library, (state) => state.builds);
  const runs = useStore(library, (state) => state.runs);
  return selectBuildCards({ builds, runs });
}

function BuildFiles({
  buildId,
  nav,
  library,
  run,
  actions,
}: {
  buildId: string;
  nav: StoreApi<NavState>;
  library: StoreApi<LibraryState>;
  run: StoreApi<RunState>;
  actions: Actions;
}) {
  const files = useStore(library, (state) =>
    state.files?.buildId === buildId ? state.files : null,
  );
  const card = useCards(library).find((build) => build.id === buildId);
  const blocked = useRunDisabled(run, card);

  useEffect(() => {
    void library.getState().openFiles(buildId);
  }, [library, buildId]);

  const shown = files?.list.find((file) => file.path === files.selected);
  return (
    <>
      <header className="fd-page-head">
        <nav className="fd-crumbs" aria-label="Breadcrumb">
          <button
            className="fd-crumb"
            data-testid={pageTestIds.buildBack}
            onClick={() => nav.getState().go({ name: "builds" })}
          >
            Builds
          </button>
          <span aria-hidden="true">/</span>
          <h1 className="fd-page-title fd-page-title-small" data-testid={pageTestIds.title}>
            {card?.name ?? "Build"} {card === undefined ? "" : versionText(card)}
          </h1>
        </nav>
        <div className="fd-page-bar">
          <p className="fd-page-note">
            Locked. These are the exact files a run of this build uses.
          </p>
          <button
            className="fd-btn fd-btn-primary"
            data-testid={pageTestIds.buildDetailRun}
            disabled={blocked}
            title={card === undefined ? undefined : (selectRunHint(card) ?? undefined)}
            onClick={() => void actions.runBuild(buildId)}
          >
            Run
          </button>
        </div>
      </header>
      <BlueprintPicture library={library} pictureKey={{ buildId }} testId={buildId} />
      <div className="fd-files">
        <ul className="fd-file-list" aria-label="Files">
          {files?.list.map((file) => (
            <li key={file.path}>
              <button
                className="fd-file-row"
                data-testid={pageTestIds.buildFile(file.path)}
                aria-current={file.path === files.selected ? "true" : undefined}
                onClick={() => library.getState().selectFile(file.path)}
              >
                <Icon name="file" />
                <span className="fd-ellipsis">{file.path}</span>
              </button>
            </li>
          ))}
        </ul>
        <pre className="fd-file-content" data-testid={pageTestIds.buildFileContent} tabIndex={0}>
          {shown?.content ?? ""}
        </pre>
      </div>
    </>
  );
}

const buildingTones: Record<BuildOutcome | "building", string> = {
  building: "live",
  built: "ok",
  "needs-you": "warn",
  failed: "fail",
  stopped: "quiet",
};

function BuildingCardView({
  card,
  outcome,
  nav,
}: {
  card: BuildingCard;
  outcome: BuildOutcome | undefined;
  nav: StoreApi<NavState>;
}) {
  return (
    <button
      className="fd-card fd-card-link"
      data-testid={pageTestIds.buildingCard(card.pendingId)}
      title="See this build's pipeline"
      onClick={() => nav.getState().go({ name: "building", pendingId: card.pendingId })}
    >
      <span className="fd-card-top">
        <span className="fd-card-name">
          {card.buildName}{" "}
          <span className="fd-muted">
            {card.blueprintName ?? ""}
            {card.blueprintVersion === undefined ? "" : ` v${card.blueprintVersion}`}
          </span>
        </span>
        <span className={`fd-badge fd-badge-${buildingTones[outcome ?? "building"]}`}>
          {card.badge}
        </span>
        {card.live && <span className="fd-live-dot" aria-hidden="true" />}
      </span>
      <span className="fd-card-meta">
        <span>Started {formatWhen(card.startedAt)}</span>
      </span>
    </button>
  );
}

function BuildCardView({
  card,
  nav,
  library,
  run,
  actions,
}: {
  card: BuildCard;
  nav: StoreApi<NavState>;
  library: StoreApi<LibraryState>;
  run: StoreApi<RunState>;
  actions: Actions;
}) {
  const blocked = useRunDisabled(run, card);
  const hint = selectRunHint(card);
  const interrupted = card.run?.status === "interrupted" ? card.run : null;
  const resume = async (runId: string) => {
    const resumed = await run.getState().resume(runId);
    await library.getState().refresh();
    if (resumed !== null) nav.getState().go({ name: "run", runId: resumed });
  };
  return (
    <article className="fd-card" data-testid={pageTestIds.buildCard(card.id)}>
      <div className="fd-card-top">
        <button
          className="fd-card-name"
          data-testid={pageTestIds.buildOpen(card.id)}
          title="See its files"
          onClick={() => nav.getState().go({ name: "builds", buildId: card.id })}
        >
          {card.name}{" "}
          <span className="fd-muted">
            {card.blueprint === "" || card.blueprint === card.name ? "" : `${card.blueprint} `}
            {versionText(card)}
          </span>
        </button>
        {card.old && (
          <span
            className="fd-badge fd-badge-quiet"
            data-testid={pageTestIds.buildOld(card.id)}
            title={hint ?? undefined}
          >
            old
          </span>
        )}
      </div>
      <div className="fd-card-meta">
        <span>Built {formatWhen(card.createdAt)}</span>
        {hint !== null && <span>{hint}</span>}
      </div>
      <div className="fd-card-actions">
        <button
          className="fd-btn"
          data-testid={pageTestIds.buildRun(card.id)}
          disabled={blocked}
          title={hint ?? undefined}
          onClick={() => void actions.runBuild(card.id)}
        >
          Run
        </button>
        {interrupted !== null && (
          <>
            <button
              className="fd-btn"
              data-testid={pageTestIds.buildResume(card.id)}
              title="Carry on from where the run stopped"
              onClick={() => void resume(interrupted.id)}
            >
              Resume
            </button>
            <button
              className="fd-btn"
              data-testid={pageTestIds.buildStop(card.id)}
              title="Mark the run stopped, so the build can run again"
              onClick={() => void actions.stopRun(interrupted.id)}
            >
              Stop
            </button>
          </>
        )}
        <button
          className="fd-btn"
          data-testid={pageTestIds.buildDelete(card.id)}
          title="Delete the build, its workspace and its branch"
          onClick={() => void actions.deleteBuild(card.id)}
        >
          Delete
        </button>
      </div>
    </article>
  );
}

export function BuildsPage({
  buildId,
  nav,
  library,
  run,
  buildProgress,
  actions,
}: {
  buildId: string | undefined;
  nav: StoreApi<NavState>;
  library: StoreApi<LibraryState>;
  run: StoreApi<RunState>;
  buildProgress: StoreApi<BuildProgressState>;
  actions: Actions;
}) {
  const cards = useCards(library);
  const entries = useStore(buildProgress, (state) => state.entries);
  const buildingCards = useMemo(() => selectBuildingCards({ entries }), [entries]);
  const loaded = useStore(library, (state) => state.loaded);
  const query = useStore(nav, (state) => state.query);
  const sort = useStore(nav, (state) => state.sort);
  const kept = useStore(run, (state) => state.kept);
  if (buildId !== undefined) {
    return <BuildFiles buildId={buildId} nav={nav} library={library} run={run} actions={actions} />;
  }
  const shown = arrange(cards, { query, sort }, (card) => card.name);
  const shownBuilding = arrange(buildingCards, { query, sort }, (card) => card.buildName);
  return (
    <>
      <PageHead title="Builds" nav={nav} searchLabel="Search builds" />
      {kept !== null && (
        <p className="fd-page-note" data-testid={pageTestIds.buildKept(kept.buildId)} role="status">
          {selectKeptNote(kept)}
        </p>
      )}
      {loaded && cards.length === 0 && buildingCards.length === 0 && (
        <Empty>No builds yet. Build a saved blueprint from its card or from the editor.</Empty>
      )}
      <div className="fd-cards">
        {shownBuilding.map((card) => (
          <BuildingCardView
            key={card.pendingId}
            card={card}
            outcome={entries[card.pendingId]?.outcome}
            nav={nav}
          />
        ))}
        {shown.map((card) => (
          <BuildCardView
            key={card.id}
            card={card}
            nav={nav}
            library={library}
            run={run}
            actions={actions}
          />
        ))}
      </div>
    </>
  );
}
