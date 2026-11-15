import type { PipelineLane, PipelineRow } from "../../../core/run/build-pipeline.js";
import { statusBadge } from "../canvas/status-look.js";
import { formatDuration } from "../format.js";
import { useNow } from "../use-now.js";

type Status = PipelineLane["status"] | PipelineRow["status"];

const statusGlyphs: Record<Status, string> = {
  waiting: "○",
  running: "●",
  done: "✓",
  failed: "✕",
  skipped: "–",
};

export function StatusIcon({ status }: { status: Status }) {
  const { label, color } = statusBadge(status);
  return (
    <>
      <span className="fd-status-icon" style={{ color }} aria-hidden="true">
        {statusGlyphs[status]}
      </span>
      <span className="fd-visually-hidden">{label}</span>
    </>
  );
}

export function LiveElapsed({ since, testId }: { since: number; testId?: string }) {
  const now = useNow(1000);
  return <span data-testid={testId}>{formatDuration(Math.max(0, now - since))}</span>;
}

export function LaneTook({ lane, since }: { lane: PipelineLane; since: number | undefined }) {
  if (lane.durationMs !== undefined) return <span>{formatDuration(lane.durationMs)}</span>;
  if (lane.status === "running" && since !== undefined) return <LiveElapsed since={since} />;
  return null;
}
