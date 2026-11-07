const block = /^---\n([\s\S]*?)\n---\n/;

export function frontmatter(content: string): Record<string, unknown> {
  const match = block.exec(content);
  if (match === null) throw new Error(`no frontmatter in ${JSON.stringify(content.slice(0, 80))}`);
  return Object.fromEntries(
    (match[1] ?? "").split("\n").map((line) => {
      const at = line.indexOf(": ");
      return [line.slice(0, at), JSON.parse(line.slice(at + 2)) as unknown];
    }),
  );
}

export function bodyOf(content: string): string {
  return content.replace(block, "");
}

export function sectionOf(content: string, heading: RegExp): string {
  const lines = bodyOf(content).split("\n");
  const start = lines.findIndex((line) => line.startsWith("## ") && heading.test(line));
  if (start === -1) return "";
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}
