import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { BuildingCard, BuildOutcome } from "../../../core/run/build-progress.js";
import type { BuildEntry, BuildProject } from "../../../core/run/listing.js";
import type { Actions } from "../actions.js";
import { selectBuildingCards, type BuildProgressState } from "../build-progress-store.js";
import { formatWhen } from "../format.js";
import { Icon } from "../icons.js";
import { ItemMenu } from "../item-menu.js";
import {
  filterRunsByBuild,
  selectBuildCards,
  selectRunCards,
  type BuildCard,
  type LibraryState,
} from "../library-store.js";
import { arrange, type NavState } from "../nav-store.js";
import { selectKeptNote, selectRunDisabled, selectRunHint, type RunState } from "../run-store.js";
import { pageTestIds } from "../test-ids.js";
import { BlueprintPicture } from "./blueprint-picture.js";
import { BuildTree } from "./build-tree.js";
import { Empty, PageHead } from "./page-head.js";
import { RunRow } from "./runs-page.js";

const versionText = (card: Pick<BuildCard, "version">) =>
  card.version === null ? "" : `v${card.version}`;

const neverRun = { old: false, run: null };

function useRunDisabled(run: StoreApi<RunState>, card: BuildCard | undefined) {
  return useStore(run, (state) => selectRunDisabled(state, card ?? neverRun));
}

const noPaths: string[] = [];

function useCards(library: StoreApi<LibraryState>) {
  const builds = useStore(library, (state) => state.builds);
  const runs = useStore(library, (state) => state.runs);
  return selectBuildCards({ builds, runs });
}

const noEntries: BuildEntry[] = [];

function ProjectEntries({ path, library }: { path: string; library: StoreApi<LibraryState> }) {
  const entries = useStore(library, (state) => state.projectEntries[path] ?? noEntries);
  return (
    <ul className="fd-tree-level" aria-label={path}>
      {entries.map((entry) => (
        <li key={entry.name}>
          {entry.kind === "folder" ? (
            <ProjectFolder path={`${path}/${entry.name}`} name={entry.name} library={library} />
          ) : (
            <span
              className="fd-file-row fd-tree-name"
              data-testid={pageTestIds.buildProjectEntry(`${path}/${entry.name}`)}
            >
              <Icon name="file" />
              <span className="fd-ellipsis">{entry.name}</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function ProjectFolder({
  path,
  name,
  library,
}: {
  path: string;
  name: string;
  library: StoreApi<LibraryState>;
}) {
  const [open, setOpen] = useState(false);
  const toggle = () => {
    if (!open) void library.getState().expandProjectFolder(path);
    setOpen(!open);
  };
  return (
    <>
      <button
        className="fd-file-row"
        data-testid={pageTestIds.buildProjectEntry(path)}
        aria-expanded={open}
        onClick={toggle}
      >
        <Icon name="folder" />
        <span className="fd-ellipsis">{name}</span>
      </button>
      {open && <ProjectEntries path={path} library={library} />}
    </>
  );
}

function ProjectRow({
  project,
  library,
}: {
  project: BuildProject;
  library: StoreApi<LibraryState>;
}) {
  const [open, setOpen] = useState(false);
  const toggle = () => {
    if (!open) void library.getState().expandProjectFolder(project.repoFolder);
    setOpen(!open);
  };
  const name = (
    <span className="fd-ellipsis" title={project.path}>
      {project.repoFolder}
    </span>
  );
  return (
    <section className="fd-project" data-testid={pageTestIds.buildProject} aria-label="Project">
      {project.exists ? (
        <button
          className="fd-file-row"
          data-testid={pageTestIds.buildProjectToggle}
          aria-expanded={open}
          onClick={toggle}
        >
          <Icon name="folder" />
          {name}
        </button>
      ) : (
        <span className="fd-file-row fd-tree-name">
          <Icon name="folder" />
          {name}
        </span>
      )}
      <dl className="fd-project-facts">
        <div>
          <dt>Branch</dt>
          <dd className="fd-ellipsis" title={project.branch}>
            {project.branch}
          </dd>
        </div>
        <div>
          <dt>Base</dt>
          <dd className="fd-ellipsis" title={project.base}>
            {project.base}
          </dd>
        </div>
      </dl>
      <p className="fd-project-badges">
        <span className="fd-badge fd-badge-quiet">
          {project.branchCreated ? "created by Flowdeck" : "existing branch"}
        </span>{" "}
        {project.exists ? (
          <span className={`fd-badge fd-badge-${project.dirty === true ? "warn" : "ok"}`}>
            {project.dirty === true ? "dirty" : "clean"}
          </span>
        ) : (
          <span className="fd-badge fd-badge-fail">checkout missing</span>
        )}{" "}
        {project.unpushed === true && <span className="fd-badge fd-badge-warn">unpushed</span>}
      </p>
      {open && project.exists && <ProjectEntries path={project.repoFolder} library={library} />}
    </section>
  );
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
  const tree = useStore(library, (state) => (state.tree?.buildId === buildId ? state.tree : null));
  const project = useStore(library, (state) =>
    state.project?.buildId === buildId ? state.project : null,
  );
  const card = useCards(library).find((build) => build.id === buildId);
  const blocked = useRunDisabled(run, card);
  const runs = useStore(library, (state) => state.runs);
  const snapshots = useStore(run, (state) => state.snapshots);
  const runCards = filterRunsByBuild(selectRunCards({ runs }), buildId);
  const now = Date.now();

  useEffect(() => {
    void library.getState().openFiles(buildId);
  }, [library, buildId]);

  const shown = files?.list.find((file) => file.path === files.selected);
  const selection =
    files === null
      ? undefined
      : {
          selected: files.selected,
          onSelect: (path: string) => library.getState().selectFile(path),
        };
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
            {card?.name ?? runCards[0]?.name ?? "Build"}{" "}
            {card === undefined ? "" : versionText(card)}
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
        <div className="fd-files-side">
          <BuildTree paths={tree?.paths ?? noPaths} selection={selection} />
          {project !== null && <ProjectRow project={project} library={library} />}
        </div>
        <pre className="fd-file-content" data-testid={pageTestIds.buildFileContent} tabIndex={0}>
          {shown?.content ?? ""}
        </pre>
      </div>
      <section className="fd-section fd-build-runs" aria-label="Runs">
        <div className="fd-section-head">
          <h2>Runs</h2>
        </div>
        <div className="fd-cards" data-testid={pageTestIds.buildRuns}>
          {runCards.length === 0 ? (
            <p className="fd-page-note">No runs yet.</p>
          ) : (
            runCards.map((card) => (
              <RunRow
                key={card.id}
                card={card}
                live={snapshots[card.id] ?? null}
                now={now}
                run={run}
                onOpen={() => nav.getState().go({ name: "run", runId: card.id })}
              />
            ))
          )}
        </div>
      </section>
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
  run,
}: {
  card: BuildingCard;
  outcome: BuildOutcome | undefined;
  nav: StoreApi<NavState>;
  run: StoreApi<RunState>;
}) {
  return (
    <article className="fd-card fd-card-corner">
      <button
        className="fd-card-link fd-card-open"
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
      <ItemMenu
        run={run}
        menuKey={`building:${card.pendingId}`}
        triggerTestId={pageTestIds.buildingMenu(card.pendingId)}
        label="Build actions"
        items={[
          {
            testId: pageTestIds.buildingDelete(card.pendingId),
            label: "Delete",
            onSelect: () => void run.getState().askDelete({ kind: "pending", id: card.pendingId }),
          },
        ]}
      />
    </article>
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
  const runGoing = card.run?.status === "running" || interrupted !== null;
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
        <ItemMenu
          run={run}
          menuKey={`build:${card.id}`}
          triggerTestId={pageTestIds.buildMenu(card.id)}
          label="Build actions"
          items={[
            {
              testId: pageTestIds.buildDelete(card.id),
              label: "Delete",
              ...(runGoing && { disabled: true, title: "Stop or resume its run first" }),
              onSelect: () => void run.getState().askDelete({ kind: "build", id: card.id }),
            },
          ]}
        />
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
  const removed = useStore(buildProgress, (state) => state.removed);
  const buildingCards = useMemo(
    () => selectBuildingCards({ entries, removed }),
    [entries, removed],
  );
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
            run={run}
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
