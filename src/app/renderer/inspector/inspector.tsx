import type { CSSProperties } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { selectSelectedNode, type CanvasState } from "../canvas/store.js";
import { statusBadge } from "../canvas/status-look.js";
import { selectNodeDisplay, type RunState } from "../run-store.js";
import type { ShellState } from "../shell-store.js";
import { ActivityFeed } from "./activity-feed.js";
import { Ask } from "./ask.js";
import { NodeSettingsSection } from "./node-settings.js";
import { SessionSettingsSection } from "./session-settings.js";
import type { InspectorState } from "./store.js";
import type { WaitState } from "./wait-store.js";

const rowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  minWidth: 0,
  overflow: "hidden",
  whiteSpace: "nowrap",
  fontSize: 12,
  padding: "2px 0",
};

const headingStyle: CSSProperties = { fontSize: 13, margin: "12px 0 4px" };

function NodeRow({
  run,
  nodeId,
  label,
}: {
  run: StoreApi<RunState>;
  nodeId: string;
  label: string;
}) {
  const status = useStore(run, (state) => selectNodeDisplay(state, nodeId));
  return (
    <li data-testid={`inspector-node-${nodeId}`} data-status={status ?? undefined} style={rowStyle}>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
      {status !== null && <span style={{ color: statusBadge(status).color }}>{status}</span>}
    </li>
  );
}

function RunView({
  inspector,
  run,
  canvas,
}: {
  inspector: StoreApi<InspectorState>;
  run: StoreApi<RunState>;
  canvas: StoreApi<CanvasState>;
}) {
  const sessionName = useStore(canvas, (state) => state.flow.session.name);
  const nodes = useStore(canvas, (state) => state.flow.nodes);
  const runStatus = useStore(run, (state) => state.snapshot?.status ?? "idle");
  return (
    <>
      <h2 style={headingStyle}>Session</h2>
      <div
        data-testid="inspector-session"
        data-status={runStatus}
        style={{ ...rowStyle, flexShrink: 0 }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{sessionName}</span>
        <span>{runStatus}</span>
      </div>
      <h2 style={headingStyle}>Nodes</h2>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, minWidth: 0 }}>
        {nodes.map((node) => (
          <NodeRow key={node.id} run={run} nodeId={node.id} label={node.label} />
        ))}
      </ul>
      <h2 style={headingStyle}>Activity</h2>
      <div style={{ flex: "0 1 auto", minHeight: 0, overflowY: "auto" }}>
        <ActivityFeed inspector={inspector} run={run} canvas={canvas} />
      </div>
    </>
  );
}

export function Inspector({
  inspector,
  run,
  canvas,
  wait,
  shell,
}: {
  inspector: StoreApi<InspectorState>;
  run: StoreApi<RunState>;
  canvas: StoreApi<CanvasState>;
  wait: StoreApi<WaitState>;
  shell: StoreApi<ShellState>;
}) {
  const sessionSettingsOpen = useStore(shell, (state) => state.sessionSettingsOpen);
  const nodeSelected = useStore(canvas, (state) => selectSelectedNode(state) !== null);
  const width = useStore(shell, (state) => state.panelWidths.inspector);
  return (
    <aside
      data-testid="inspector"
      style={{
        width,
        flexShrink: 0,
        minWidth: 0,
        maxHeight: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "auto",
        fontSize: 12,
      }}
    >
      <Ask wait={wait} />
      {sessionSettingsOpen ? (
        <>
          <h2 style={headingStyle}>Session settings</h2>
          <SessionSettingsSection canvas={canvas} />
        </>
      ) : nodeSelected ? (
        <NodeSettingsSection canvas={canvas} />
      ) : (
        <RunView inspector={inspector} run={run} canvas={canvas} />
      )}
    </aside>
  );
}
