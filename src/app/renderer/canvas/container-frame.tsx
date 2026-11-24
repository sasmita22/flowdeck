import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { flowIn, flowOut } from "../../../core/flow/structure.js";
import { FrameRect, ignoredMarks } from "../nodes/shape.js";
import { frameLook } from "../nodes/outlines.js";
import { containerTestIds } from "../test-ids.js";
import { connectionPorts } from "./view.js";

type ContainerFrameNode = Node<{
  containerId?: string;
  label?: string;
  session?: boolean;
  ignored?: boolean;
}>;

export function ContainerFrame({ data, width, height, selected }: NodeProps<ContainerFrameNode>) {
  const id = data.containerId ?? "";
  return (
    <div
      data-testid={containerTestIds.frame(id)}
      data-selected={selected}
      {...ignoredMarks(data.ignored)}
      style={{
        position: "relative",
        width,
        height,
        borderRadius: frameLook.rx,
        boxShadow: selected ? "0 0 0 2px var(--select)" : undefined,
      }}
    >
      <FrameRect width={width} height={height} color="var(--c-io)" dashed={false} />
      <span
        style={{
          position: "absolute",
          top: 6,
          left: 12,
          color: "var(--c-io)",
          fontSize: "var(--fs-xs)",
          fontWeight: 600,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          pointerEvents: "none",
        }}
      >
        {data.label}
      </span>
      <Handle
        id={flowIn}
        type="target"
        position={Position.Left}
        data-testid={containerTestIds.frameFlowIn(id)}
      />
      <Handle
        id={flowOut}
        type="source"
        position={Position.Right}
        data-testid={containerTestIds.frameFlowOut(id)}
      />
      {data.session === true && (
        <>
          <Handle
            id={connectionPorts.target}
            type="target"
            position={Position.Top}
            data-testid={containerTestIds.frameTarget(id)}
          />
          <Handle
            id={connectionPorts.source}
            type="source"
            position={Position.Bottom}
            data-testid={containerTestIds.frameSource(id)}
          />
        </>
      )}
    </div>
  );
}
