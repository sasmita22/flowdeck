import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { FrameRect } from "../nodes/shape.js";
import { frameLook } from "../nodes/outlines.js";
import { containerTestIds } from "../test-ids.js";
import { connectionPorts } from "./view.js";

type ContainerFrameNode = Node<{ containerId?: string; label?: string; session?: boolean }>;

export function ContainerFrame({ data, width, height, selected }: NodeProps<ContainerFrameNode>) {
  return (
    <div
      data-testid={containerTestIds.frame(data.containerId ?? "")}
      data-selected={selected}
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
      {data.session === true && (
        <>
          <Handle
            id={connectionPorts.target}
            type="target"
            position={Position.Left}
            data-testid={containerTestIds.frameTarget(data.containerId ?? "")}
          />
          <Handle
            id={connectionPorts.source}
            type="source"
            position={Position.Right}
            data-testid={containerTestIds.frameSource(data.containerId ?? "")}
          />
        </>
      )}
    </div>
  );
}
