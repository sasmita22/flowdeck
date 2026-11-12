type Fields = Record<string, unknown>;

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFileWire = (wire: unknown): wire is Fields & { from: Fields; to: Fields; file: string } =>
  isFields(wire) &&
  wire.kind === "file" &&
  typeof wire.file === "string" &&
  isFields(wire.from) &&
  isFields(wire.to);

const withFile = (list: unknown, file: string): unknown[] => {
  const files = Array.isArray(list) ? list : [];
  return files.includes(file) ? files : [...files, file];
};

const addFile = (nodes: unknown[], id: unknown, key: "given" | "writes", file: string) =>
  nodes.map((node) =>
    isFields(node) && node.id === id && node.type === "agent" && isFields(node.settings)
      ? { ...node, settings: { ...node.settings, [key]: withFile(node.settings[key], file) } }
      : node,
  );

export function fileWiresToSettings(raw: unknown): unknown {
  if (!isFields(raw) || !Array.isArray(raw.nodes) || !Array.isArray(raw.wires)) return raw;
  const fileWires = raw.wires.filter(isFileWire);
  if (fileWires.length === 0) return raw;
  const nodes = fileWires.reduce<unknown[]>(
    (current, wire) =>
      addFile(
        addFile(current, wire.from.node, "writes", wire.file),
        wire.to.node,
        "given",
        wire.file,
      ),
    raw.nodes,
  );
  return { ...raw, nodes, wires: raw.wires.filter((wire) => !isFileWire(wire)) };
}
