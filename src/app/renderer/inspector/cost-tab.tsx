import { useEffect, type CSSProperties } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { CanvasState } from "../canvas/store.js";
import { formatCost, formatDuration, formatTokens } from "../format.js";
import type { RunState } from "../run-store.js";

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
  canvas,
}: {
  runId: string;
  run: StoreApi<RunState>;
  canvas: StoreApi<CanvasState>;
}) {
  const report = useStore(run, (state) => (state.cost?.runId === runId ? state.cost.report : null));
  const changed = useStore(run, (state) =>
    state.snapshot?.runId === runId ? JSON.stringify(state.snapshot) : "",
  );
  const nodes = useStore(canvas, (state) => state.flow.nodes);

  useEffect(() => {
    void run.getState().loadCost(runId);
  }, [run, runId, changed]);

  if (report === null) return <p data-testid="cost-loading">Reading the cost…</p>;
  const labelOf = (nodeId: string) => nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
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
          <tr key={line.nodeId} data-testid={`cost-node-${line.nodeId}`}>
            <td style={nameCell} title={labelOf(line.nodeId)}>
              {labelOf(line.nodeId)}
            </td>
            <td style={cell}>{formatTokens(line.tokens).replace(" tokens", "")}</td>
            <td style={cell}>{formatCost(line.cost)}</td>
            <td style={cell}>{timeOf(line.ms)}</td>
          </tr>
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
