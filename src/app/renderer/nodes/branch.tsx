import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { ports } from "../../../core/nodes/branch/ports.js";
import { useNodeDisplay } from "../canvas/status.js";
import { Label, NodeShape, TagPill, type ShapeNode } from "./shape.js";
import { nodeLook } from "./look.js";

type BranchViewNode = Node<ShapeNode["data"] & { sub?: string }>;

const { box, group } = nodeLook("branch");
const [w, h] = [box.width, box.height];
const points = `12,0 ${w - 12},0 ${w},${h / 2} ${w - 12},${h} 12,${h} 0,${h / 2}`;
const outline = `M${points.replaceAll(" ", " L")} Z`;
const padL = 14;

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
      outline={outline}
      padL={padL}
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
      <polygon points={points} fill={group} fillOpacity={0.6} />
      <TagPill type="branch" padL={padL} />
      <Label type="branch" padL={padL} text={data.label} />
      {status === null && (
        <text x={padL} y={39} fill="var(--muted)" style={{ font: "400 11px var(--f-body)" }}>
          {data.sub}
        </text>
      )}
    </NodeShape>
  );
}
