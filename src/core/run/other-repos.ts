import type { ActivityEntry } from "./activity.js";

export type CandidateOptions = { home?: string };

const candidateCap = 200;
const pathFields = ["file_path", "path", "notebook_path"] as const;
const folderToken = /(?:^|[\s;&|("])(?:cd|git\s+-C)\s+([^\s;&|)"'\\]+)/g;
const quotedField = /"(?:file_path|path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const folderTokens = (text: string): string[] =>
  [...text.matchAll(folderToken)].map((match) => match[1] ?? "");

function rawPaths(input: string): string[] {
  const value = parsed(input);
  if (typeof value !== "object" || value === null) {
    return [
      ...[...input.matchAll(quotedField)].map((match) => parsed(`"${match[1] ?? ""}"`)),
      ...folderTokens(input),
    ].filter((path): path is string => typeof path === "string");
  }
  const record = value as Record<string, unknown>;
  const command = record["command"];
  return [
    ...pathFields.map((field) => record[field]).filter((path) => typeof path === "string"),
    ...(typeof command === "string" ? folderTokens(command) : []),
  ];
}

function absolute(path: string, home: string | undefined): string | undefined {
  if (path.startsWith("~/")) return home === undefined ? undefined : `${home}${path.slice(1)}`;
  return path.startsWith("/") ? path : undefined;
}

export function candidatePaths(
  entries: readonly ActivityEntry[],
  { home }: CandidateOptions,
): string[] {
  const found = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "tool" || entry.input === undefined) continue;
    for (const path of rawPaths(entry.input)) {
      const resolved = absolute(path, home);
      if (resolved !== undefined) found.add(resolved);
    }
  }
  return [...found].sort().slice(0, candidateCap);
}
