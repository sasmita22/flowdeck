export const frontmatterOf = (content: string): Map<string, string> => {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(content)?.[1] ?? "";
  const fields = new Map<string, string>();
  for (const line of block.split("\n")) {
    const match = /^([\w-]+):\s*(.*)$/.exec(line);
    if (match !== null) fields.set(match[1] ?? "", (match[2] ?? "").trim());
  }
  return fields;
};
