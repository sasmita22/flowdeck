export const ports = [
  { name: "in", direction: "in", kind: "then" },
  { name: "out", direction: "out", kind: "then" },
  { name: "file-in", direction: "in", kind: "file" },
  { name: "file-out", direction: "out", kind: "file" },
] as const;
