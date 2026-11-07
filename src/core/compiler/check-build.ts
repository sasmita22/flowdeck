import type { Flow } from "../flow/schema.js";
import { hasTemplate, templatePath } from "./handoff-templates.js";
import type { BuildFile, Manifest, ManifestNode } from "./lower.js";
import { orchestratorPath } from "./orchestrator.js";
import { pieceOf } from "./pieces.js";
import { scopeLine, scopeOf } from "./scope-line.js";
import { standardRules } from "./standard-rules.js";

export type BuildCheckFailure = { file: string; rule: string; detail: string };

export type BuildCheckInputs = {
  laidDown: readonly BuildFile[];
  readBack: readonly BuildFile[];
  manifest: Manifest;
  flow: Flow;
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

type Piece = { file: string; piece: string; type: ManifestNode["type"]; labels: string[] };

const piecesOf = (manifest: Manifest): Piece[] => {
  const byFile = new Map<string, Piece>();
  for (const node of manifest.nodes) {
    if (node.file === undefined || (node.type !== "agent" && node.type !== "prompt")) continue;
    const known = byFile.get(node.file);
    if (known === undefined) {
      byFile.set(node.file, {
        file: node.file,
        piece: pieceOf(node),
        type: node.type,
        labels: [node.label],
      });
    } else {
      known.labels.push(node.label);
    }
  }
  return [...byFile.values()];
};

export function checkBuild(inputs: BuildCheckInputs): BuildCheckFailure[] {
  const { laidDown, readBack, manifest, flow } = inputs;
  const laid = new Map(laidDown.map((file) => [file.path, file.content]));
  const back = new Map(readBack.map((file) => [file.path, file.content]));
  const failures: BuildCheckFailure[] = [];
  const fail = (file: string, rule: string, detail: string) => {
    failures.push({ file, rule, detail });
  };
  const pieces = piecesOf(manifest);
  const pieceNames = new Set([...pieces.map((piece) => piece.piece), "run"]);
  const prefix = manifest.prefix ?? "";
  const allowed = new Set(manifest.session.allowedTools);

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

    if (piece.type === "agent") {
      const tools = (fields.get("tools") ?? "")
        .split(",")
        .map((tool) => tool.trim())
        .filter((tool) => tool !== "");
      const outside = tools.filter((tool) => !allowed.has(tool));
      if (outside.length > 0)
        fail(piece.file, "tools", `tools outside the session's allow list: ${outside.join(", ")}`);
    }

    if (bodyOf(content) === bodyOf(laid.get(piece.file) ?? ""))
      fail(piece.file, "body", "body has nothing beyond its draft");
  }

  for (const [path, content] of back) {
    if (path.startsWith("plugin/") && !laid.has(path))
      fail(path, "extra", "file was not laid down by code");
    if (unfilledLine.test(content)) fail(path, "unfilled", "an @unfilled line is left");
    if (path.startsWith("plugin/") && path.endsWith(".md")) {
      for (const match of content.matchAll(/([a-z0-9][a-z0-9-]*):([a-z0-9][a-z0-9-]*)/g)) {
        const [reference = "", owner, target = ""] = match;
        if (owner === prefix && !pieceNames.has(target))
          fail(path, "reference", `${reference} names no piece of this build`);
        else if (owner !== prefix && pieceNames.has(target))
          fail(path, "reference", `${reference} uses another build's prefix`);
      }
    }
  }

  for (const path of codeOwned) {
    if (back.get(path) !== laid.get(path)) fail(path, "code-owned", "differs from what code wrote");
  }

  if (!(back.get("CLAUDE.md") ?? "").includes(standardRules.text))
    fail("CLAUDE.md", "standard-rules", "the standard rules are missing or altered");

  const fileWires = new Set(
    flow.wires.flatMap((wire) =>
      wire.kind === "file" && hasTemplate(wire.file) ? [wire.file] : [],
    ),
  );
  for (const file of fileWires) {
    if (!back.has(templatePath(file)))
      fail(templatePath(file), "template", `File wire ${file} has no template`);
  }

  const orchestrator = back.get(orchestratorPath);
  const marked = (orchestrator ?? "")
    .split("\n")
    .flatMap((line) => /^\d+\. NODE (\S+) /.exec(line)?.[1] ?? []);
  const expected = manifest.nodes.map((node) => node.id);
  if (orchestrator === undefined) fail(orchestratorPath, "missing", "the orchestrator is missing");
  else if (marked.join("\n") !== expected.join("\n"))
    fail(orchestratorPath, "orchestrator", "NODE markers do not follow the manifest's order");

  return failures;
}
