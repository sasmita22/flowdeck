import type { CSSProperties } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { paletteItems } from "../canvas/palette-items.js";
import { triggerFlags } from "../../../core/nodes/branch/execute.js";
import {
  selectFieldIssues,
  selectNodeIssues,
  selectSelectedNode,
  type CanvasState,
} from "../canvas/store.js";
import { Field, type Commit } from "./field.js";
import { applyNodeSetting, describeNodeFields } from "./node-form.js";

const headingStyle: CSSProperties = { fontSize: "var(--fs-md)", margin: "12px 0 4px" };

const labelStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 2 };

export function NodeSettingsSection({ canvas }: { canvas: StoreApi<CanvasState> }) {
  const node = useStore(canvas, selectSelectedNode);
  const flow = useStore(canvas, (state) => state.flow);
  if (node === null) return null;
  const item = paletteItems.find((entry) => entry.type === node.type);
  const fields = describeNodeFields(node.type, flow);
  const issues = selectFieldIssues(flow, node.id);
  const problems = selectNodeIssues(flow)[node.id] ?? [];
  const noFlags = node.type === "branch" && Object.keys(triggerFlags(flow.nodes)).length === 0;

  const current = () => selectSelectedNode(canvas.getState());
  const commit: Commit = (path, value) => {
    const selected = current();
    if (selected === null) return null;
    const result = applyNodeSetting(selected, path, value);
    if ("error" in result) return result.error;
    canvas.getState().updateNode(result.node);
    return null;
  };
  const rename = (label: string) => {
    const selected = current();
    if (selected !== null && label !== selected.label) {
      canvas.getState().updateNode({ ...selected, label });
    }
  };

  return (
    <section
      key={node.id}
      data-testid="node-settings"
      aria-label="Node"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        flexShrink: 0,
        fontSize: "var(--fs-sm)",
      }}
    >
      <h2 style={headingStyle}>Node</h2>
      {item !== undefined && (
        <>
          <span className="fd-palette-head">
            <span
              className="fd-tag"
              data-testid="node-type-tag"
              style={{
                color: item.color,
                background: `color-mix(in srgb, ${item.color} 15%, transparent)`,
              }}
            >
              {item.tag}
            </span>
            <span data-testid="node-type-name">{item.label}</span>
          </span>
          <span className="fd-palette-description" data-testid="node-type-description">
            {item.description}
          </span>
        </>
      )}
      {problems.length > 0 && (
        <ul className="fd-node-problems" data-testid="node-problems" aria-label="Problems">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      <label style={labelStyle}>
        Label
        <input
          key={node.label}
          data-testid="node-label"
          type="text"
          defaultValue={node.label}
          onBlur={(event) => rename(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </label>
      {fields.map((field) => (
        <Field
          key={field.testId}
          field={field}
          values={node.settings}
          commit={commit}
          issues={issues}
        />
      ))}
      {noFlags && (
        <span className="fd-hint" data-testid="branch-no-flags">
          The Trigger has no flags yet. Select the Trigger, add a flag under Flags, then pick it
          here.
        </span>
      )}
      {fields.length === 0 && (
        <span className="fd-palette-description">Nothing else to set up.</span>
      )}
    </section>
  );
}
