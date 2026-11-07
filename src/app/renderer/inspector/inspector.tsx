import type { CSSProperties } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { ActivityEntry } from "../../../core/run/activity.js";
import type { BranchState } from "../branch-store.js";
import { labelFor, selectSelectedNode, type CanvasState } from "../canvas/store.js";
import { statusBadge } from "../canvas/status-look.js";
import {
  selectNodeDisplay,
  selectSessionStatus,
  type RunState,
  type RunView,
} from "../run-store.js";
import { useShownWidth } from "../resize-handle.js";
import type { RunTab, ShellState } from "../shell-store.js";
import type { TerminalState } from "../terminal/store.js";
import { ActivityFeed } from "./activity-feed.js";
import { Ask } from "./ask.js";
import { CostTab } from "./cost-tab.js";
import { FilesTab } from "./files-tab.js";
import { NodeSettingsSection } from "./node-settings.js";
import { SessionSettingsSection } from "./session-settings.js";
import type { InspectorState } from "./store.js";
import { TerminalTab } from "./terminal-tab.js";
import type { WaitState } from "./wait-store.js";

export type RunPageView = {
  runId: string;
  run: StoreApi<RunState>;
  terminal: StoreApi<TerminalState>;
  stored: readonly ActivityEntry[];
  canRetry: boolean;
};

const noWait: StoreApi<Pick<WaitState, "pending">> = {
  getState: () => ({ pending: null }),
  getInitialState: () => ({ pending: null }),
  setState: () => undefined,
  subscribe: () => () => undefined,
};

const rowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  minWidth: 0,
  overflow: "hidden",
  whiteSpace: "nowrap",
  fontSize: "var(--fs-sm)",
  padding: "2px 0",
};

const headingStyle: CSSProperties = { fontSize: "var(--fs-md)", margin: "12px 0 4px" };

const reasonStyle: CSSProperties = {
  margin: "0 0 4px",
  color: "#ef4444",
  fontSize: "var(--fs-xs)",
  overflowWrap: "anywhere",
};

function NodeRow({
  run,
  nodeId,
  label,
  page,
}: {
  run: StoreApi<RunView>;
  nodeId: string;
  label: string;
  page: RunPageView | undefined;
}) {
  const status = useStore(run, (state) => selectNodeDisplay(state, nodeId));
  const reason = useStore(run, (state) => state.snapshot?.reasons?.[nodeId]);
  return (
    <li data-testid={`inspector-node-${nodeId}`} data-status={status ?? undefined}>
      <div style={rowStyle}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
        {status !== null && <span style={{ color: statusBadge(status).color }}>{status}</span>}
      </div>
      {status === "failed" && reason !== undefined && (
        <p data-testid={`inspector-reason-${nodeId}`} style={reasonStyle}>
          {reason}
        </p>
      )}
      {status === "failed" && page?.canRetry === true && (
        <button
          className="fd-btn"
          data-testid={`retry-${nodeId}`}
          title="Send this node again and carry on from it"
          style={{ marginBottom: 6 }}
          onClick={() => void page.run.getState().retry(page.runId, nodeId)}
        >
          Retry
        </button>
      )}
    </li>
  );
}

function RunView({
  inspector,
  run,
  canvas,
  wait,
  page,
}: {
  inspector: StoreApi<InspectorState>;
  run: StoreApi<RunView>;
  canvas: StoreApi<CanvasState>;
  wait: StoreApi<Pick<WaitState, "pending">>;
  page: RunPageView | undefined;
}) {
  const sessionName = useStore(canvas, (state) => state.flow.session.name);
  const nodes = useStore(canvas, (state) => state.flow.nodes);
  const waiting = useStore(wait, (state) => state.pending !== null);
  const runStatus = useStore(run, (state) => selectSessionStatus(state, waiting));
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
          <NodeRow key={node.id} run={run} nodeId={node.id} label={labelFor(node)} page={page} />
        ))}
      </ul>
      <h2 style={headingStyle}>Activity</h2>
      <div style={{ flex: "0 1 auto", minHeight: 0, overflowY: "auto" }}>
        <ActivityFeed inspector={inspector} run={run} canvas={canvas} stored={page?.stored} />
      </div>
    </>
  );
}

const tabs: { tab: RunTab; label: string }[] = [
  { tab: "activity", label: "Activity" },
  { tab: "files", label: "Files" },
  { tab: "cost", label: "Cost" },
  { tab: "terminal", label: "Terminal" },
];

function RunTabs({
  inspector,
  run,
  canvas,
  wait,
  shell,
  page,
}: {
  inspector: StoreApi<InspectorState>;
  run: StoreApi<RunView>;
  canvas: StoreApi<CanvasState>;
  wait: StoreApi<Pick<WaitState, "pending">>;
  shell: StoreApi<ShellState>;
  page: RunPageView;
}) {
  const current = useStore(shell, (state) => state.runTab);
  return (
    <>
      <div className="fd-tabs" role="tablist" aria-label="Run views">
        {tabs.map(({ tab, label }) => (
          <button
            key={tab}
            className="fd-tab"
            role="tab"
            aria-selected={current === tab}
            data-testid={`run-tab-${tab}`}
            onClick={() => shell.getState().setRunTab(tab)}
          >
            {label}
          </button>
        ))}
      </div>
      {current === "activity" && (
        <RunView inspector={inspector} run={run} canvas={canvas} wait={wait} page={page} />
      )}
      {current === "files" && (
        <FilesTab inspector={inspector} run={run} canvas={canvas} stored={page.stored} />
      )}
      {current === "cost" && <CostTab runId={page.runId} run={page.run} canvas={canvas} />}
      {current === "terminal" && <TerminalTab terminal={page.terminal} />}
    </>
  );
}

export function Inspector({
  inspector,
  run,
  canvas,
  wait,
  shell,
  readOnly = false,
  page,
  branches,
}: {
  inspector: StoreApi<InspectorState>;
  run: StoreApi<RunView>;
  canvas: StoreApi<CanvasState>;
  wait?: StoreApi<WaitState> | undefined;
  shell: StoreApi<ShellState>;
  readOnly?: boolean;
  page?: RunPageView | undefined;
  branches?: StoreApi<BranchState> | undefined;
}) {
  const sessionSettingsOpen = useStore(shell, (state) => state.sessionSettingsOpen) && !readOnly;
  const nodeSelected = useStore(canvas, (state) => selectSelectedNode(state) !== null) && !readOnly;
  const width = useShownWidth(shell, run, "inspector");
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
        fontSize: "var(--fs-sm)",
      }}
    >
      {wait !== undefined && <Ask wait={wait} />}
      {sessionSettingsOpen ? (
        <>
          <h2 style={headingStyle}>Session settings</h2>
          <SessionSettingsSection canvas={canvas} branches={branches} />
        </>
      ) : nodeSelected ? (
        <NodeSettingsSection canvas={canvas} />
      ) : page !== undefined ? (
        <RunTabs
          inspector={inspector}
          run={run}
          canvas={canvas}
          wait={wait ?? noWait}
          shell={shell}
          page={page}
        />
      ) : (
        <RunView
          inspector={inspector}
          run={run}
          canvas={canvas}
          wait={wait ?? noWait}
          page={undefined}
        />
      )}
    </aside>
  );
}
