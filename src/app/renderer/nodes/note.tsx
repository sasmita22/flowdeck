import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { useContext, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { noteTitle } from "../canvas/palette-items.js";
import { CanvasStoreContext } from "../canvas/status.js";
import { noteLook } from "./note-look.js";

type NoteNode = Node<{ text?: string }>;

const textStyle = {
  boxSizing: "border-box",
  width: "100%",
  height: "100%",
  margin: 0,
  padding: "10px 12px",
  border: "none",
  background: "transparent",
  color: noteLook.ink,
  font: "13px/1.45 var(--f-body)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  overflow: "hidden",
  resize: "none",
  outline: "none",
} as const;

export function NoteNode({ id, data, selected }: NodeProps<NoteNode>) {
  const store = useContext(CanvasStoreContext);
  const text = data.text ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const latest = useRef(text);
  latest.current = text;

  useEffect(() => {
    const element = box.current;
    if (element === null) return;
    // d3-zoom zooms on a dblclick at the pane before React's root listener would see it.
    const startEditing = (event: MouseEvent) => {
      event.stopPropagation();
      setDraft((current) => current ?? latest.current);
    };
    element.addEventListener("dblclick", startEditing);
    return () => element.removeEventListener("dblclick", startEditing);
  }, []);

  const finish = () => {
    if (draft === null) return;
    store?.getState().editNoteText(id, draft);
    setDraft(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") finish();
  };

  return (
    <div
      ref={box}
      data-testid={`note-${id}`}
      title={noteTitle}
      style={{
        boxSizing: "border-box",
        width: "100%",
        height: "100%",
        borderRadius: noteLook.rx,
        background: noteLook.fill,
        border: `1px solid ${noteLook.stroke}`,
        boxShadow: selected ? "0 0 0 2px var(--select)" : undefined,
      }}
    >
      <NodeResizer
        isVisible={selected && draft === null}
        minWidth={noteLook.minSize.width}
        minHeight={noteLook.minSize.height}
        color="var(--select)"
        onResize={(_, next) => store?.getState().resizeNoteLive(id, next)}
        onResizeEnd={(_, next) => store?.getState().resizeNote(id, next)}
      />
      {draft === null ? (
        <div data-testid={`note-text-${id}`} style={textStyle}>
          {text === "" ? (
            <span style={{ color: "var(--muted)" }}>Double-click to write</span>
          ) : (
            text
          )}
        </div>
      ) : (
        <textarea
          data-testid={`note-text-${id}`}
          className="nodrag nopan nowheel"
          aria-label="Note text"
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={finish}
          onKeyDown={onKeyDown}
          style={textStyle}
        />
      )}
    </div>
  );
}
