import type { CSSProperties } from "react";

export const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  fontSize: "var(--fs-sm)",
};

export const fieldRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  minWidth: 0,
};

export const issueStyle: CSSProperties = {
  color: "var(--warn)",
  fontSize: "var(--fs-xs)",
  lineHeight: 1.35,
};
