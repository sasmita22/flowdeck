import { useId } from "react";
import type { NodeType } from "../../../core/flow/schema.js";
import { nodeLook } from "./look.js";
import { barPreview, framePreview, previewOf, previewViewBox, type Preview } from "./outlines.js";
import { Extras, TagChip } from "./shape.js";

type Of<Kind extends Preview["kind"]> = Extract<Preview, { kind: Kind }>;

function OutlinePreview({ preview }: { preview: Of<"node"> }) {
  const clip = `fd-preview-${useId().replace(/[^\w-]/g, "")}`;
  const { type, outline } = preview;
  const { tag, group, outline: stroke } = nodeLook(type);
  return (
    <>
      <defs>
        <clipPath id={clip}>
          <path d={outline.path} />
        </clipPath>
      </defs>
      <path
        d={outline.path}
        fill={outline.fill}
        stroke={stroke}
        strokeWidth={outline.strokeWidth}
      />
      <g clipPath={`url(#${clip})`}>
        <Extras extras={outline.extras} />
        <TagChip x={outline.padL} tag={tag} fill={outline.ink ?? group} />
      </g>
    </>
  );
}

function BarPreview({ preview }: { preview: Of<"bar"> }) {
  const { type, bar } = preview;
  const { group, outline } = nodeLook(type);
  const { width, height, reach, rows } = barPreview;
  const x = type === "fork" ? 0 : reach;
  const wire = (row: number) =>
    type === "fork" ? `M${width},${row} H${width + reach}` : `M0,${row} H${reach}`;
  return (
    <>
      {rows.map((row) => (
        <path key={row} d={wire(row)} fill="none" stroke="var(--muted)" strokeWidth={1.4} />
      ))}
      <rect
        x={x}
        width={width}
        height={height}
        rx={bar.rx}
        fill={group}
        fillOpacity={bar.fillOpacity}
        stroke={outline}
        strokeWidth={bar.strokeWidth}
      />
    </>
  );
}

function FramePreview({ preview }: { preview: Of<"frame"> }) {
  const { group, tag } = nodeLook(preview.type);
  const { rx, fillOpacity, strokeOpacity, strokeWidth, dash } = preview.frame;
  return (
    <>
      <rect
        width={framePreview.width}
        height={framePreview.height}
        rx={rx}
        fill={group}
        fillOpacity={fillOpacity}
        stroke={group}
        strokeOpacity={strokeOpacity}
        strokeWidth={strokeWidth}
        strokeDasharray={dash}
      />
      <TagChip x={10} tag={tag} fill={group} />
      {[10, 54].map((x) => (
        <rect
          key={x}
          x={x}
          y={28}
          width={34}
          height={20}
          rx={4}
          fill="var(--panel)"
          stroke="var(--line)"
          strokeOpacity={0.8}
        />
      ))}
    </>
  );
}

const previewLines = [
  { y: 11, width: 112 },
  { y: 25, width: 140 },
  { y: 39, width: 84 },
];

function NotePreview({ preview }: { preview: Of<"note"> }) {
  const { rx, fill, stroke, ink } = preview.note;
  return (
    <>
      <rect
        width={framePreview.width}
        height={framePreview.height}
        rx={rx}
        style={{ fill, stroke }}
        strokeWidth={1}
      />
      {previewLines.map(({ y, width }) => (
        <rect
          key={y}
          x={12}
          y={y}
          width={width}
          height={5}
          rx={2.5}
          fill={ink}
          fillOpacity={0.35}
        />
      ))}
    </>
  );
}

function PreviewBody({ preview }: { preview: Preview }) {
  switch (preview.kind) {
    case "node":
      return <OutlinePreview preview={preview} />;
    case "bar":
      return <BarPreview preview={preview} />;
    case "frame":
      return <FramePreview preview={preview} />;
    case "note":
      return <NotePreview preview={preview} />;
  }
}

export function NodePreview({ type }: { type: NodeType | "note" }) {
  return (
    <svg viewBox={previewViewBox(type)} aria-hidden="true" className="fd-preview">
      <PreviewBody preview={previewOf(type)} />
    </svg>
  );
}
