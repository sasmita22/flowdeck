import type { NodeProps } from "@xyflow/react";
import { useContext } from "react";
import { useStore } from "zustand";
import { nodeWidth } from "../canvas/frames.js";
import { CanvasStoreContext, emptyCanvasStore } from "../canvas/status.js";
import { libraryTestIds } from "../test-ids.js";
import { libraryCaption } from "./library-caption.js";
import { nodeOutline } from "./outlines.js";
import { Label, NodeShape, TagPill, type ShapeNode } from "./shape.js";

export function LibraryNode({ id, data, selected }: NodeProps<ShapeNode>) {
  const store = useContext(CanvasStoreContext) ?? emptyCanvasStore;
  const caption = useStore(store, (state) => {
    const node = state.flow.nodes.find((candidate) => candidate.id === id);
    return libraryCaption(
      node?.type === "library" ? node.settings.libraryId : undefined,
      state.libraries,
    );
  });
  return (
    <NodeShape
      id={id}
      type="library"
      selected={selected}
      highlighted={data.highlighted}
      ignored={data.ignored}
      width={nodeWidth({ type: "library", label: data.label ?? "", sub: caption })}
    >
      <TagPill type="library" />
      <Label type="library" text={data.label} />
      <text
        x={nodeOutline("library").padL}
        y={39}
        fill="var(--muted)"
        style={{ font: "400 11px var(--f-body)" }}
        data-testid={libraryTestIds.name(id)}
      >
        {caption}
      </text>
    </NodeShape>
  );
}
