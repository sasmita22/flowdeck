const warm = "var(--c-ctrl)";

export const noteLook = {
  size: { width: 220, height: 120 },
  minSize: { width: 140, height: 64 },
  rx: 6,
  fill: `color-mix(in srgb, ${warm} 9%, var(--panel))`,
  stroke: `color-mix(in srgb, ${warm} 30%, var(--line))`,
  ink: "var(--fg)",
  tag: warm,
} as const;
