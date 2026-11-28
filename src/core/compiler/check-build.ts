import { stopMarker } from "../run/stop-marker.js";
import type { BuildReport } from "./build-report.js";
import {
  connectedSessionsHeading,
  namedSendLine,
  replyFallbackLine,
  sessionEntryHeading,
  sessionStatesHeading,
} from "./emit.js";
import type { BuildFile, Manifest, ManifestContainer, ManifestNode } from "./lower.js";
import { stopsTheRun } from "../run/stop-marker.js";
import { producedRows } from "../nodes/agent/execute.js";
import { containerRoot, pieceOf } from "./pieces.js";
import { scopeLine, scopeOf } from "./scope-line.js";
import { sharedContainer, sharedPath } from "./shared.js";
import { standardRules } from "./standard-rules.js";

export type BuildCheckFailure = { file: string; rule: string; detail: string; container?: string };

export const failureLine = (failure: BuildCheckFailure) =>
  `${failure.container === undefined ? "" : `[${failure.container}] `}${failure.file} ${failure.rule}: ${failure.detail}`;

export type BuildCheckInputs = {
  laidDown: readonly BuildFile[];
  readBack: readonly BuildFile[];
  manifest: Manifest;
  shared: BuildReport["shared"];
};

const descriptionFloor = 60;

const codeOwned = ["plugin/hooks/hooks.json", "plugin/.claude-plugin/plugin.json", "settings.json"];
const unfilledLine = /^@unfilled.*\n\n?/m;

const frontmatterBlock = /^---\n([\s\S]*?)\n---\n/;

const fold = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

const fieldValue = (raw: string): string => {
  if (!raw.startsWith('"')) return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : raw;
  } catch {
    return raw;
  }
};

const frontmatterOf = (content: string): Map<string, string> => {
  const block = frontmatterBlock.exec(content)?.[1] ?? "";
  const fields = new Map<string, string>();
  for (const line of block.split("\n")) {
    const match = /^([\w-]+):\s*(.*)$/.exec(line);
    if (match !== null) fields.set(match[1] ?? "", fieldValue((match[2] ?? "").trim()));
  }
  return fields;
};

const bodyOf = (content: string) =>
  content.replace(frontmatterBlock, "").replace(unfilledLine, "").trim();

type Piece = { file: string; piece: string; labels: string[] };

const piecesOf = (nodes: readonly ManifestNode[]): Piece[] => {
  const byFile = new Map<string, Piece>();
  for (const node of nodes) {
    if (node.file === undefined || node.type !== "agent") continue;
    const known = byFile.get(node.file);
    if (known === undefined) {
      byFile.set(node.file, {
        file: node.file,
        piece: pieceOf(node),
        labels: [node.label],
      });
    } else {
      known.labels.push(node.label);
    }
  }
  return [...byFile.values()];
};

type Check = {
  back: ReadonlyMap<string, string>;
  laid: ReadonlyMap<string, string>;
  fail: (file: string, rule: string, detail: string) => void;
};

const checkPieces = (pieces: readonly Piece[], { back, laid, fail }: Check) => {
  for (const piece of pieces) {
    const content = back.get(piece.file);
    if (content === undefined) {
      fail(piece.file, "missing", `piece ${piece.piece} has no file`);
      continue;
    }
    const fields = frontmatterOf(content);
    const name = fields.get("name");
    if (name === undefined) fail(piece.file, "frontmatter", "frontmatter has no name");
    else if (name !== piece.piece)
      fail(piece.file, "frontmatter", `name ${name} is not the piece ${piece.piece}`);

    const description = fields.get("description");
    const laidScope = scopeOf(frontmatterOf(laid.get(piece.file) ?? "").get("description") ?? "");
    const scope = laidScope === undefined ? undefined : scopeLine(laidScope);
    if (description === undefined) {
      fail(piece.file, "frontmatter", "frontmatter has no description");
    } else if (scope === undefined || !description.startsWith(scope)) {
      fail(piece.file, "scope-line", "description does not start with this build's scope line");
    } else {
      const text = description.slice(scope.length).trim();
      if (text.length < descriptionFloor)
        fail(piece.file, "description", `description is under ${descriptionFloor} characters`);
      if (piece.labels.some((label) => fold(label) === fold(text)))
        fail(piece.file, "description", "description is the node label");
    }

    if (fields.has("tools"))
      fail(
        piece.file,
        "tools",
        `piece ${piece.piece} has a tools line; every agent uses every tool`,
      );

    if (bodyOf(content) === bodyOf(laid.get(piece.file) ?? ""))
      fail(piece.file, "body", "body has nothing beyond its draft");
  }
};

const checkShared = (
  container: ManifestContainer,
  shared: BuildReport["shared"],
  { back, laid, fail }: Check,
) => {
  const root = containerRoot(container);
  const filesOf = (ids: readonly string[]) => [
    ...new Set(ids.flatMap((id) => container.nodes.find((node) => node.id === id)?.file ?? [])),
  ];
  for (const entry of shared) {
    const path = sharedPath(entry, root);
    const content = back.get(path);
    if (content === undefined || content.trim() === "") {
      fail(path, "missing", `shared ${entry.kind} ${entry.name} has no content`);
    } else {
      if (frontmatterOf(content).get("description") === undefined)
        fail(path, "frontmatter", "frontmatter has no description");
      if (bodyOf(content) === bodyOf(laid.get(path) ?? ""))
        fail(path, "body", "body has nothing beyond its draft");
    }
    const reference = `${container.prefix}:${entry.name}`;
    for (const file of filesOf(entry.usedBy)) {
      const agentFile = back.get(file);
      if (agentFile === undefined) continue;
      if (!agentFile.includes(reference))
        fail(file, "shared", `never runs the shared ${entry.kind} ${reference}`);
    }
  }
};

const checkContainer = (
  container: ManifestContainer,
  shared: BuildReport["shared"],
  check: Check,
) => {
  const { back, laid, fail } = check;
  const root = containerRoot(container);
  const plugin = `${root}/plugin/`;
  const pieces = piecesOf(container.nodes);
  const pieceNames = new Set([
    ...pieces.map((piece) => piece.piece),
    "run",
    ...shared.map((entry) => entry.name),
  ]);
  const { prefix } = container;

  checkPieces(pieces, check);
  checkShared(container, shared, check);

  for (const [path, content] of back) {
    if (!path.startsWith(plugin)) continue;
    if (!laid.has(path)) fail(path, "extra", "file was not laid down by code");
    if (path.endsWith(".md")) {
      for (const match of content.matchAll(/([a-z0-9][a-z0-9-]*):([a-z0-9][a-z0-9-]*)/g)) {
        const [reference = "", owner, target = ""] = match;
        if (owner === prefix && !pieceNames.has(target))
          fail(path, "reference", `${reference} names no piece of this build`);
        else if (owner !== prefix && pieceNames.has(target))
          fail(path, "reference", `${reference} uses another build's prefix`);
      }
    }
  }

  for (const path of codeOwned.map((file) => `${root}/${file}`)) {
    if (back.get(path) !== laid.get(path)) fail(path, "code-owned", "differs from what code wrote");
  }

  const claudeMd = `${root}/CLAUDE.md`;
  if (!(back.get(claudeMd) ?? "").includes(standardRules.text))
    fail(claudeMd, "standard-rules", "the standard rules are missing or altered");

  const orchestratorPath = container.orchestrator;
  const orchestrator = back.get(orchestratorPath);
  const stepLines = (orchestrator ?? "").split("\n").flatMap((line) => {
    const id = /^\d+\. NODE (\S+) /.exec(line)?.[1];
    return id === undefined ? [] : [{ id, line }];
  });
  const marked = stepLines.map((step) => step.id);
  const expected = container.nodes.map((node) => node.id);
  if (orchestrator === undefined) fail(orchestratorPath, "missing", "the orchestrator is missing");
  else if (marked.join("\n") !== expected.join("\n"))
    fail(orchestratorPath, "orchestrator", "NODE markers do not follow the manifest's order");
  const stopping = container.nodes.filter(
    (node) =>
      stopsTheRun(node) || (node.type === "agent" && producedRows(node.settings).length > 0),
  );
  for (const node of stopping) {
    const marker = `\`${stopMarker(node.id)}\``;
    const step = stepLines.find((candidate) => candidate.id === node.id);
    if (step !== undefined && !step.line.includes(marker))
      fail(
        orchestratorPath,
        "stop-marker",
        `the step line of NODE ${node.id} in ${container.name} lost its ${marker} line`,
      );
  }
};

const workspaceClaudeMdPath = `${containerRoot({ kind: "workspace", slug: "workspace" })}/CLAUDE.md`;

const sessionEntry = (claudeMd: string, container: ManifestContainer): string | undefined => {
  const lines = claudeMd.split("\n");
  const start = lines.indexOf(sessionEntryHeading(container));
  if (start === -1) return undefined;
  const fences = lines.flatMap((line, i) => (i > start && line.startsWith("```") ? [i] : []));
  const end = fences[1];
  return end === undefined ? undefined : lines.slice(start, end + 1).join("\n");
};

const checkSessionList = (container: ManifestContainer, { back, laid, fail }: Check) => {
  const entry = sessionEntry(laid.get(workspaceClaudeMdPath) ?? "", container);
  if (entry !== undefined && !(back.get(workspaceClaudeMdPath) ?? "").includes(entry))
    fail(
      workspaceClaudeMdPath,
      "session-list",
      `the session list entry for ${container.name} is missing or altered`,
    );
};

const blockUnder = (heading: string, claudeMd: string): string | undefined => {
  const lines = claudeMd.split("\n");
  const start = lines.indexOf(heading);
  if (start === -1) return undefined;
  let end = start + 2;
  while (lines[end]?.startsWith("- ") === true) end += 1;
  return lines.slice(start, end).join("\n");
};

const checkConnected = (container: ManifestContainer, { back, laid, fail }: Check) => {
  const path = `${containerRoot(container)}/CLAUDE.md`;
  const block = blockUnder(connectedSessionsHeading, laid.get(path) ?? "");
  if (block === undefined || (back.get(path) ?? "").includes(block)) return;
  if (container.kind === "session")
    fail(
      path,
      "session-peers",
      `the connected sessions of ${container.name} are missing or altered`,
    );
  else fail(path, "connected-pairs", "the list of connected session pairs is missing or altered");
};

const checkSessionStates = ({ back, laid, fail }: Check) => {
  const block = blockUnder(sessionStatesHeading, laid.get(workspaceClaudeMdPath) ?? "");
  if (block !== undefined && !(back.get(workspaceClaudeMdPath) ?? "").includes(block))
    fail(
      workspaceClaudeMdPath,
      "session-states",
      "the session states section is missing or altered",
    );
};

const checkLine = (
  container: ManifestContainer,
  { back, laid, fail }: Check,
  { line, rule, detail }: { line: string; rule: string; detail: string },
) => {
  const path = `${containerRoot(container)}/CLAUDE.md`;
  const isLine = (candidate: string) => candidate === line;
  if (
    (laid.get(path) ?? "").split("\n").some(isLine) &&
    !(back.get(path) ?? "").split("\n").some(isLine)
  )
    fail(path, rule, detail);
};

const checkReplyFallback = (container: ManifestContainer, check: Check) =>
  checkLine(container, check, {
    line: replyFallbackLine,
    rule: "reply-fallback",
    detail: `the reply rule of ${container.name} is missing or altered`,
  });

const checkNamedSend = (container: ManifestContainer, check: Check) =>
  checkLine(container, check, {
    line: namedSendLine,
    rule: "named-send",
    detail: `the send rule of ${container.name} is missing or altered`,
  });

export function checkBuild(inputs: BuildCheckInputs): BuildCheckFailure[] {
  const { laidDown, readBack, manifest, shared } = inputs;
  const laid = new Map(laidDown.map((file) => [file.path, file.content]));
  const back = new Map(readBack.map((file) => [file.path, file.content]));
  const failures: BuildCheckFailure[] = [];
  const { containers } = manifest;

  for (const container of containers) {
    const fail = (file: string, rule: string, detail: string) => {
      failures.push({ file, rule, detail, container: container.slug });
    };
    const own = shared.filter((entry) => sharedContainer(containers, entry) === container);
    checkContainer(container, own, { back, laid, fail });
    if (container.kind === "session") {
      checkSessionList(container, { back, laid, fail });
      checkReplyFallback(container, { back, laid, fail });
    } else checkSessionStates({ back, laid, fail });
    checkConnected(container, { back, laid, fail });
    checkNamedSend(container, { back, laid, fail });
  }

  for (const [path, content] of back) {
    if (!unfilledLine.test(content)) continue;
    const owner = containers.find((container) => path.startsWith(`${containerRoot(container)}/`));
    failures.push({
      file: path,
      rule: "unfilled",
      detail: "an @unfilled line is left",
      ...(owner === undefined ? {} : { container: owner.slug }),
    });
  }

  return failures;
}
