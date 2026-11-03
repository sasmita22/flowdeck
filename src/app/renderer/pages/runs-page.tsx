import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { formatCost, formatDuration, formatWhen } from "../format.js";
import { selectRunCards, type LibraryState, type RunCard } from "../library-store.js";
import { arrange, type NavState } from "../nav-store.js";
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

export const durationOf = (run: Pick<RunCard, "createdAt" | "endedAt" | "status">, now: number) => {
  if (run.status !== "running" && run.endedAt === null) return "—";
  const end = run.endedAt === null ? now : Date.parse(run.endedAt);
  return formatDuration(Math.max(0, end - Date.parse(run.createdAt)));
};

export function RunsPage({
  nav,
  library,
  run,
}: {
  nav: StoreApi<NavState>;
  library: StoreApi<LibraryState>;
  run: StoreApi<RunState>;
}) {
  const flows = useStore(library, (state) => state.flows);
  const runs = useStore(library, (state) => state.runs);
  const loaded = useStore(library, (state) => state.loaded);
  const snapshots = useStore(run, (state) => state.snapshots);
  const query = useStore(nav, (state) => state.query);
  const sort = useStore(nav, (state) => state.sort);
  const cards = arrange(selectRunCards({ flows, runs }), { query, sort }, (card) => card.name);
  const now = Date.now();
  return (
    <>
      <PageHead title="Runs" nav={nav} searchLabel="Search runs" />
      {loaded && runs.length === 0 && <Empty>No runs yet. Run a build from Builds.</Empty>}
      <div className="fd-cards">
        {cards.map((card) => {
          const live = snapshots[card.id] ?? null;
          const status = live?.status ?? card.status;
          const badge = selectLiveBadge(live) ?? status;
          return (
            <article key={card.id} className="fd-card" data-testid={pageTestIds.runCard(card.id)}>
              <div className="fd-card-top">
                <button
                  className="fd-card-name"
                  data-testid={pageTestIds.runOpen(card.id)}
                  title="Open this run"
                  onClick={() => nav.getState().go({ name: "run", runId: card.id })}
                >
                  {card.name}{" "}
                  <span className="fd-muted">
                    {card.version === null ? "" : `v${card.version}`}
                  </span>
                </button>
                <span
                  className={`fd-badge fd-badge-${badge === "needs you" ? "warn" : tone[status]}`}
                  data-testid={pageTestIds.runResult(card.id)}
                  data-status={status}
                >
                  {badge}
                </span>
              </div>
              <div className="fd-card-meta">
                <span>Started {formatWhen(card.createdAt)}</span>
                <span>{durationOf({ ...card, status }, now)}</span>
                <span>{formatCost(card.totalCost)}</span>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
