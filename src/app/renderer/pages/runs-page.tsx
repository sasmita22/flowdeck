import { useStore } from "zustand";
import type { RunSnapshot } from "../../../core/run/snapshot.js";
import type { StoreApi } from "zustand/vanilla";
import { formatCost, formatDuration, formatWhen } from "../format.js";
import {
  filterRunsByBuild,
  selectRunBuildOptions,
  selectRunCards,
  type LibraryState,
  type RunCard,
} from "../library-store.js";
import { arrange, type NavState } from "../nav-store.js";
import { ItemMenu } from "../item-menu.js";
import { selectLiveBadge, type RunState } from "../run-store.js";
import { pageTestIds } from "../test-ids.js";
import { Empty, PageHead } from "./page-head.js";

const tone: Record<RunCard["status"], string> = {
  running: "live",
  done: "ok",
  failed: "fail",
  stopped: "quiet",
  interrupted: "quiet",
};

const durationOf = (run: Pick<RunCard, "createdAt" | "endedAt" | "status">, now: number) => {
  if (run.status !== "running" && run.endedAt === null) return "—";
  const end = run.endedAt === null ? now : Date.parse(run.endedAt);
  return formatDuration(Math.max(0, end - Date.parse(run.createdAt)));
};

const doneOf = (card: RunCard, live: RunSnapshot | null) =>
  live?.status === "running"
    ? Object.values(live.nodes).filter((state) => state === "done").length
    : card.doneCount;

export function RunRow({
  card,
  live,
  now,
  run,
  onOpen,
}: {
  card: RunCard;
  live: RunSnapshot | null;
  now: number;
  run: StoreApi<RunState>;
  onOpen(): void;
}) {
  const status = live?.status ?? card.status;
  const badge = selectLiveBadge(live) ?? status;
  return (
    <article className="fd-card" data-testid={pageTestIds.runCard(card.id)}>
      <div className="fd-card-top">
        <button
          className="fd-card-name"
          data-testid={pageTestIds.runOpen(card.id)}
          title="Open this run"
          onClick={onOpen}
        >
          #{card.number} {card.name}{" "}
          <span className="fd-muted">{card.version === null ? "" : `v${card.version}`}</span>
        </button>
        <span
          className={`fd-badge fd-badge-${badge === "needs you" ? "warn" : tone[status]}`}
          data-testid={pageTestIds.runResult(card.id)}
          data-status={status}
        >
          {badge}
        </span>
        <ItemMenu
          run={run}
          menuKey={`run:${card.id}`}
          triggerTestId={pageTestIds.runMenu(card.id)}
          label="Run actions"
          items={[
            {
              testId: pageTestIds.runDelete(card.id),
              label: "Delete",
              onSelect: () =>
                void run.getState().askDelete({ kind: "run", id: card.id, from: "runs" }),
            },
          ]}
        />
      </div>
      {card.storyLine !== undefined && (
        <p className="fd-ellipsis fd-run-story-line" data-testid={pageTestIds.runRowStoryLine}>
          {card.storyLine}
        </p>
      )}
      <div className="fd-card-meta">
        <span>Started {formatWhen(card.createdAt)}</span>
        <span>{durationOf({ ...card, status }, now)}</span>
        <span>{formatCost(card.totalCost)}</span>
        <span data-testid={pageTestIds.runCardStages(card.id)}>
          stages {doneOf(card, live)} of {card.nodeCount}
        </span>
      </div>
    </article>
  );
}

export function RunsPage({
  nav,
  library,
  run,
}: {
  nav: StoreApi<NavState>;
  library: StoreApi<LibraryState>;
  run: StoreApi<RunState>;
}) {
  const runs = useStore(library, (state) => state.runs);
  const loaded = useStore(library, (state) => state.loaded);
  const snapshots = useStore(run, (state) => state.snapshots);
  const query = useStore(nav, (state) => state.query);
  const sort = useStore(nav, (state) => state.sort);
  const runsBuild = useStore(nav, (state) => state.runsBuild);
  const cards = arrange(
    filterRunsByBuild(selectRunCards({ runs }), runsBuild),
    { query, sort },
    (card) => card.name,
  );
  const now = Date.now();
  return (
    <>
      <PageHead
        title="Runs"
        nav={nav}
        searchLabel="Search runs"
        action={
          <select
            className="fd-select"
            data-testid={pageTestIds.runsBuildFilter}
            aria-label="Build"
            value={runsBuild ?? ""}
            onChange={(event) =>
              nav
                .getState()
                .setRunsBuild(event.target.value === "" ? undefined : event.target.value)
            }
          >
            <option value="">All builds</option>
            {selectRunBuildOptions(runs).map((option) => (
              <option key={option.buildId} value={option.buildId}>
                {option.label}
              </option>
            ))}
          </select>
        }
      />
      {loaded && runs.length === 0 && <Empty>No runs yet. Run a build from Builds.</Empty>}
      <div className="fd-cards">
        {cards.map((card) => (
          <RunRow
            key={card.id}
            card={card}
            live={snapshots[card.id] ?? null}
            now={now}
            run={run}
            onOpen={() => nav.getState().go({ name: "run", runId: card.id })}
          />
        ))}
      </div>
    </>
  );
}
