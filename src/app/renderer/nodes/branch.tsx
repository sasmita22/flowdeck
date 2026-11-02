import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { ports } from "../../../core/nodes/branch/ports.js";
import { useNodeDisplay } from "../canvas/status.js";
import { nodeOutline } from "./outlines.js";
import { Label, NodeShape, TagPill, type ShapeNode } from "./shape.js";

type BranchViewNode = Node<ShapeNode["data"] & { sub?: string }>;

const placement: Record<(typeof ports)[number]["name"], Position> = {
  in: Position.Left,
  yes: Position.Right,
  no: Position.Bottom,
};

export function BranchNode({ id, data, selected }: NodeProps<BranchViewNode>) {
  const status = useNodeDisplay(id);
  return (
    <NodeShape
      id={id}
      type="branch"
      selected={selected}
      highlighted={data.highlighted}
      handles={ports.map(({ name, direction }) => (
        <Handle
          key={name}
          id={name}
          type={direction === "in" ? "target" : "source"}
          position={placement[name]}
          data-testid={`port-${id}-${name}`}
        />
      ))}
    >
      <TagPill type="branch" />
      <Label type="branch" text={data.label} />
      {status === null && (
        <text
          x={nodeOutline("branch").padL}
          y={39}
          fill="var(--muted)"
          style={{ font: "400 11px var(--f-body)" }}
        >
          {data.sub}
        </text>
      )}
    </NodeShape>
  );
}
