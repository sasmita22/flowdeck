import { Fragment, useEffect, type CSSProperties } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { formatCost, formatDuration, formatTokens } from "../format.js";
import { selectRunSnapshot, type RunState } from "../run-store.js";
import { runNodeLabel, type RunLabels } from "./inspector.js";

const cell: CSSProperties = { padding: "4px 4px", textAlign: "right", whiteSpace: "nowrap" };
const nameCell: CSSProperties = {
  ...cell,
  textAlign: "left",
  maxWidth: 110,
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const timeOf = (ms: number | null) => (ms === null ? "—" : formatDuration(ms));

export function CostTab({
  runId,
  run,
  labels,
}: {
  runId: string;
  run: StoreApi<RunState>;
  labels: RunLabels;
}) {
  const report = useStore(run, (state) => (state.cost?.runId === runId ? state.cost.report : null));
  const changed = useStore(run, (state) => JSON.stringify(selectRunSnapshot(state, runId)));

  useEffect(() => {
    void run.getState().loadCost(runId);
  }, [run, runId, changed]);

  if (report === null) return <p data-testid="cost-loading">Reading the cost…</p>;
  const shown = report.nodes.filter((line) => line.ms !== null || line.tokens > 0);
  return (
    <table data-testid="cost-tab" style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr style={{ color: "var(--muted)", fontSize: "var(--fs-xs)" }}>
          <th style={nameCell}>Node</th>
          <th style={cell}>Tokens</th>
          <th style={cell}>Cost</th>
          <th style={cell}>Time</th>
        </tr>
      </thead>
      <tbody>
        {shown.map((line) => (
          <Fragment key={line.nodeId}>
            <tr data-testid={`cost-node-${line.nodeId}`}>
              <td style={nameCell} title={runNodeLabel(labels, line.nodeId)}>
                {runNodeLabel(labels, line.nodeId)}
              </td>
              <td style={cell}>{formatTokens(line.tokens).replace(" tokens", "")}</td>
              <td style={cell}>{formatCost(line.cost)}</td>
              <td style={cell}>{timeOf(line.ms)}</td>
            </tr>
            {(line.rounds ?? []).map((round) => (
              <tr
                key={round.round}
                data-testid={`cost-round-${line.nodeId}-${round.round}`}
                style={{ color: "var(--muted)" }}
              >
                <td style={{ ...nameCell, paddingLeft: 16 }}>Round {round.round}</td>
                <td style={cell}>{formatTokens(round.tokens).replace(" tokens", "")}</td>
                <td style={cell}>{formatCost(round.cost)}</td>
                <td style={cell} />
              </tr>
            ))}
          </Fragment>
        ))}
        <tr
          data-testid="cost-total"
          style={{ borderTop: "1px solid var(--line)", fontWeight: 600 }}
        >
          <td style={nameCell}>Session</td>
          <td style={cell}>{formatTokens(report.total.tokens).replace(" tokens", "")}</td>
          <td style={cell}>{formatCost(report.total.cost)}</td>
          <td style={cell}>{formatDuration(report.total.ms)}</td>
        </tr>
      </tbody>
    </table>
  );
}
