import { Handle, Position, useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import { useContext, useRef, type CSSProperties, type PointerEvent } from "react";
import { flowIn, flowOut } from "../../../core/flow/structure.js";
import { FrameRect, ignoredMarks } from "../nodes/shape.js";
import { frameLook } from "../nodes/outlines.js";
import { containerTestIds, type FrameGripSide } from "../test-ids.js";
import { CanvasEditingContext, CanvasStoreContext } from "./status.js";
import { connectionPorts } from "./view.js";

type ContainerFrameNode = Node<{
  containerId?: string;
  label?: string;
  session?: boolean;
  ignored?: boolean;
}>;

type Point = { x: number; y: number };

const gripEdge = 8;

const gripBoxes: Record<FrameGripSide, CSSProperties> = {
  top: { top: 0, left: 0, right: 0, height: 22 },
  left: { top: 0, bottom: 0, left: 0, width: gripEdge },
  right: { top: 0, bottom: 0, right: 0, width: gripEdge },
  bottom: { bottom: 0, left: 0, right: 0, height: gripEdge },
};

const gripSides = Object.keys(gripBoxes) as FrameGripSide[];

function useFrameDrag(frameId: string, origin: Point) {
  const store = useContext(CanvasStoreContext);
  const { screenToFlowPosition } = useReactFlow();
  const drag = useRef<{ pointer: Point; origin: Point; moved: boolean } | null>(null);
  const swallowClick = useRef(false);
  const pointerAt = (event: PointerEvent) =>
    screenToFlowPosition({ x: event.clientX, y: event.clientY });
  const finish = () => {
    const ended = drag.current;
    drag.current = null;
    if (store === null || ended?.moved !== true) return;
    swallowClick.current = true;
    store.getState().endDrag([frameId]);
  };
  return {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      swallowClick.current = false;
      drag.current = { pointer: pointerAt(event), origin, moved: false };
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const current = drag.current;
      if (store === null || current === null) return;
      const at = pointerAt(event);
      current.moved = true;
      store.getState().dragTo(frameId, {
        x: current.origin.x + at.x - current.pointer.x,
        y: current.origin.y + at.y - current.pointer.y,
      });
    },
    onPointerUp: finish,
    onPointerCancel: finish,
    onClickCapture: (event: { stopPropagation(): void }) => {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      event.stopPropagation();
    },
  };
}

function FrameGrips({ id, frameId, origin }: { id: string; frameId: string; origin: Point }) {
  const handlers = useFrameDrag(frameId, origin);
  return gripSides.map((side) => (
    <div
      key={side}
      className="nopan"
      data-testid={containerTestIds.frameGrip(id, side)}
      style={{ position: "absolute", cursor: "move", ...gripBoxes[side] }}
      {...handlers}
    />
  ));
}

export function ContainerFrame({
  id: frameId,
  data,
  width,
  height,
  selected,
  positionAbsoluteX,
  positionAbsoluteY,
}: NodeProps<ContainerFrameNode>) {
  const id = data.containerId ?? "";
  const editing = useContext(CanvasEditingContext);
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
      {editing && (
        <FrameGrips
          id={id}
          frameId={frameId}
          origin={{ x: positionAbsoluteX, y: positionAbsoluteY }}
        />
      )}
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
