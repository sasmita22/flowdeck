import { useEffect, useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type {
  BuildCost,
  BuildStepNumber,
  ComponentProgress,
  StepProgress,
} from "../../../core/run/build-progress.js";
import type { Actions } from "../actions.js";
import type { BuildProgressState } from "../build-progress-store.js";
import { formatDuration, formatWhen } from "../format.js";
import { Icon } from "../icons.js";
import { entryText } from "../inspector/store.js";
import { selectBuildCards, type BuildCard, type LibraryState } from "../library-store.js";
import { arrange, type NavState } from "../nav-store.js";
import { selectKeptNote, selectRunDisabled, selectRunHint, type RunState } from "../run-store.js";
import type { TerminalState } from "../terminal/store.js";
import { TerminalView } from "../terminal/terminal-pane.js";
import { controlTestIds, pageTestIds } from "../test-ids.js";
import { Empty, PageHead } from "./page-head.js";

const versionText = (card: Pick<BuildCard, "version">) =>
  card.version === null ? "" : `v${card.version}`;

const neverRun = { old: false, run: null };

function useRunDisabled(run: StoreApi<RunState>, card: BuildCard | undefined) {
  return useStore(run, (state) => selectRunDisabled(state, card ?? neverRun));
}

function useCards(library: StoreApi<LibraryState>) {
  const flows = useStore(library, (state) => state.flows);
  const builds = useStore(library, (state) => state.builds);
  const runs = useStore(library, (state) => state.runs);
  return selectBuildCards({ flows, builds, runs });
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

const stepNames: Record<BuildStepNumber, string> = {
  1: "Check the blueprint",
  2: "Lay down the files",
  3: "Agents write",
  4: "Agents check the hand-offs",
  5: "Verify and lock",
};

const stepStatusText = (step: StepProgress) => {
  const round = step.round === undefined ? "" : ` · round ${step.round}`;
  const took = step.tookMs === undefined ? "" : ` · ${formatDuration(step.tookMs)}`;
  return `${step.status}${round}${took}`;
};

const componentText = (component: ComponentProgress) =>
  component.nodeIds.length > 1
    ? `${component.status} · merged ${component.nodeIds.join(", ")}`
    : component.status;

const costText = (cost: BuildCost) =>
  `${cost.inputTokens} in · ${cost.outputTokens} out · $${cost.usd.toFixed(2)}`;

function BuildTerminal({
  pendingId,
  terminal,
}: {
  pendingId: string;
  terminal: StoreApi<TerminalState>;
}) {
  const [open, setOpen] = useState(false);
  const available = useStore(terminal, (state) => state.runId === pendingId && state.available);

  useEffect(() => {
    void terminal.getState().view(pendingId);
  }, [terminal, pendingId]);

  return (
    <section aria-label="Build terminal">
      <button
        className="fd-btn"
        data-testid={pageTestIds.buildTerminal(pendingId)}
        disabled={!available}
        title={available ? undefined : "The build session is not open"}
        onClick={() => setOpen(!open)}
      >
        {open ? "Hide terminal" : "Terminal"}
      </button>
      {open && available && (
        <TerminalView store={terminal} style={{ width: "100%", height: "40vh", marginTop: 8 }} />
      )}
    </section>
  );
}

function BuildActivity({
  pendingId,
  buildProgress,
}: {
  pendingId: string;
  buildProgress: StoreApi<BuildProgressState>;
}) {
  const entries = useStore(buildProgress, (state) => state.activityFor(pendingId));

  useEffect(() => {
    void buildProgress.getState().viewActivity(pendingId);
  }, [buildProgress, pendingId]);

  return (
    <section data-testid={pageTestIds.buildActivity(pendingId)} aria-label="Activity">
      <h2 className="fd-page-note">Activity</h2>
      {entries.length === 0 ? (
        <p className="fd-muted">No activity yet</p>
      ) : (
        <ol className="fd-build-steps">
          {entries.map((entry) => (
            <li key={entry.id}>
              <span>{entry.nodeId}</span>
              <span className="fd-muted">{entryText(entry)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function BuildProgressView({
  pendingId,
  nav,
  buildProgress,
  terminal,
}: {
  pendingId: string;
  nav: StoreApi<NavState>;
  buildProgress: StoreApi<BuildProgressState>;
  terminal: StoreApi<TerminalState>;
}) {
  const progress = useStore(buildProgress, (state) => state.progressFor(pendingId));
  if (progress === undefined) return null;
  const open = progress.outcomeLabel === undefined;
  const tookMs = progress.steps.reduce((total, step) => total + (step.tookMs ?? 0), 0);
  return (
    <section data-testid={pageTestIds.buildProgress(pendingId)} aria-label="Build progress">
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
            {progress.chip}
          </h1>
        </nav>
        <div className="fd-page-bar">
          {progress.outcomeLabel !== undefined && (
            <p className="fd-page-note" role="status">
              {progress.outcomeLabel} in {formatDuration(tookMs)}
            </p>
          )}
          {progress.cost !== undefined && (
            <p className="fd-page-note" data-testid={pageTestIds.buildCost(pendingId)}>
              {costText(progress.cost)}
            </p>
          )}
          {open && (
            <button
              className="fd-btn"
              data-testid={controlTestIds.buildStop}
              title="Stop the build and remove its workspace"
              onClick={() => void buildProgress.getState().stop(pendingId)}
            >
              Stop
            </button>
          )}
        </div>
      </header>
      <ol className="fd-build-steps">
        {progress.steps.map((step) => (
          <li key={step.step} data-testid={pageTestIds.buildStep(pendingId, step.step)}>
            <span>{stepNames[step.step]}</span>
            <span className="fd-muted">{stepStatusText(step)}</span>
            {step.message !== undefined && <span className="fd-muted">{step.message}</span>}
          </li>
        ))}
      </ol>
      {progress.components.length > 0 && (
        <ul className="fd-build-steps" aria-label="Components">
          {progress.components.map((component) => (
            <li
              key={component.path}
              data-testid={pageTestIds.buildComponent(pendingId, component.path)}
            >
              <span>{component.path}</span>
              <span className="fd-muted">{componentText(component)}</span>
            </li>
          ))}
        </ul>
      )}
      {progress.questions !== undefined && (
        <ol className="fd-build-steps" aria-label="Questions">
          {progress.questions.map((question, index) => (
            <li key={index} data-testid={pageTestIds.buildQuestion(pendingId, index)}>
              <span>
                {question.nodeId}
                {question.otherNodeId === undefined ? "" : ` · ${question.otherNodeId}`}
              </span>
              <span>{question.text}</span>
            </li>
          ))}
        </ol>
      )}
      <BuildActivity pendingId={pendingId} buildProgress={buildProgress} />
      {open && <BuildTerminal pendingId={pendingId} terminal={terminal} />}
    </section>
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
            {card.blueprint === card.name ? "" : `${card.blueprint} `}
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
  terminal,
  actions,
}: {
  buildId: string | undefined;
  nav: StoreApi<NavState>;
  library: StoreApi<LibraryState>;
  run: StoreApi<RunState>;
  buildProgress: StoreApi<BuildProgressState>;
  terminal: StoreApi<TerminalState>;
  actions: Actions;
}) {
  const cards = useCards(library);
  const inProgress = useStore(
    buildProgress,
    (state) => buildId !== undefined && state.progressFor(buildId) !== undefined,
  );
  const loaded = useStore(library, (state) => state.loaded);
  const query = useStore(nav, (state) => state.query);
  const sort = useStore(nav, (state) => state.sort);
  const kept = useStore(run, (state) => state.kept);
  if (buildId !== undefined && inProgress) {
    return (
      <BuildProgressView
        pendingId={buildId}
        nav={nav}
        buildProgress={buildProgress}
        terminal={terminal}
      />
    );
  }
  if (buildId !== undefined) {
    return <BuildFiles buildId={buildId} nav={nav} library={library} run={run} actions={actions} />;
  }
  const shown = arrange(cards, { query, sort }, (card) => card.name);
  return (
    <>
      <PageHead title="Builds" nav={nav} searchLabel="Search builds" />
      {kept !== null && (
        <p className="fd-page-note" data-testid={pageTestIds.buildKept(kept.buildId)} role="status">
          {selectKeptNote(kept)}
        </p>
      )}
      {loaded && cards.length === 0 && (
        <Empty>No builds yet. Build a saved blueprint from its card or from the editor.</Empty>
      )}
      <div className="fd-cards">
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
