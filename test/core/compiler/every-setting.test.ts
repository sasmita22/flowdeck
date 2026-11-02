import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { emit } from "../../../src/core/compiler/emit.js";
import { lower, type Manifest } from "../../../src/core/compiler/lower.js";
import { parseFlow, Session, type NodeType } from "../../../src/core/flow/schema.js";
import { registry } from "../../../src/core/nodes/registry.js";

type Landing =
  | { file: string; shows: string }
  | { manifest: "node"; value: unknown }
  | { manifest: "session"; value: unknown }
  | { manifest: "inputs"; value: unknown }
  | { manifest: "outputs"; value: unknown };

const inFile = (file: string, shows: string): Landing => ({ file, shows });
const atRunTime = (value: unknown): Landing => ({ manifest: "node", value });

const settings: Record<NodeType, Record<string, [unknown, Landing]>> = {
  prompt: {
    instructions: ["M-prompt-instructions", inFile("commands/p.md", "M-prompt-instructions")],
    expectedOutput: ["M-prompt-output", inFile("commands/p.md", "M-prompt-output")],
  },
  agent: {
    role: ["M-agent-role", inFile("agents/a.md", "M-agent-role")],
    instructions: ["M-agent-instructions", inFile("agents/a.md", "M-agent-instructions")],
    model: ["M-agent-model", inFile("agents/a.md", "M-agent-model")],
    tools: [["M-agent-tool"], inFile("agents/a.md", "M-agent-tool")],
    given: [["M-agent-given.md"], inFile("agents/a.md", "M-agent-given.md")],
    writes: [["M-agent-writes.md"], inFile("agents/a.md", "M-agent-writes.md")],
  },
  script: {
    command: ["M-script-command", atRunTime("M-script-command")],
    args: [["M-script-arg"], atRunTime(["M-script-arg"])],
    successCodes: [[71], atRunTime([71])],
    retryCodes: [[72], atRunTime([72])],
  },
  gate: {
    shown: ["M-gate-shown", atRunTime("M-gate-shown")],
    skippable: [true, atRunTime(true)],
  },
  ask: {
    question: ["M-ask-question", atRunTime("M-ask-question")],
    options: [["M-ask-option"], atRunTime(["M-ask-option"])],
  },
  hardstop: {
    condition: ["M-hardstop-condition", atRunTime("M-hardstop-condition")],
    shown: ["M-hardstop-shown", atRunTime("M-hardstop-shown")],
    locked: [true, atRunTime(true)],
    enabled: [true, atRunTime(true)],
  },
  loop: {
    condition: ["M-loop-condition", atRunTime("M-loop-condition")],
    cap: [73, atRunTime(73)],
    onCap: ["ask", atRunTime("ask")],
  },
  trigger: {
    inputs: [["M-trigger-input"], { manifest: "inputs", value: ["M-trigger-input"] }],
    flags: [{ "M-trigger-flag": true }, atRunTime({ "M-trigger-flag": true })],
  },
  output: {
    name: ["M-output-name", { manifest: "outputs", value: "M-output-name" }],
    type: ["M-output-type", { manifest: "outputs", value: "M-output-type" }],
  },
  fork: {},
  join: {
    wait: ["first", atRunTime("first")],
    onBranchFail: ["skip", atRunTime("skip")],
  },
  foreach: {
    file: ["M-foreach-file.md", atRunTime("M-foreach-file.md")],
  },
  branch: {
    flag: ["M-trigger-flag", atRunTime("M-trigger-flag")],
  },
};

const session: Record<string, [unknown, Landing]> = {
  name: ["M-session-name", { manifest: "session", value: "M-session-name" }],
  workingFolder: [
    { kind: "path", path: "/M-session-folder" },
    { manifest: "session", value: { kind: "path", path: "/M-session-folder" } },
  ],
  model: ["M-session-model", { manifest: "session", value: "M-session-model" }],
  allowedTools: [["M-session-tool"], inFile("settings.json", "M-session-tool")],
  permissionMode: ["M-session-mode", inFile("settings.json", "M-session-mode")],
  connectors: [["M-session-connector"], { manifest: "session", value: ["M-session-connector"] }],
  budget: [74, { manifest: "session", value: 74 }],
};

const idOf: Record<NodeType, string> = {
  prompt: "p",
  agent: "a",
  script: "s",
  gate: "g",
  ask: "k",
  hardstop: "h",
  loop: "l",
  trigger: "t",
  output: "o",
  fork: "f",
  join: "j",
  foreach: "e",
  branch: "b",
};

const valuesOf = (entries: Record<string, [unknown, Landing]>) =>
  Object.fromEntries(Object.entries(entries).map(([field, [value]]) => [field, value]));

const everyNode = () =>
  parseFlow({
    nodes: Object.entries(settings).map(([type, fields]) => ({
      id: idOf[type as NodeType],
      type,
      label: `label-${type}`,
      position: { x: 0, y: 0 },
      settings: valuesOf(fields),
    })),
    wires: [],
    session: valuesOf(session),
  });

const builtFiles = () => {
  const files = emit(lower(everyNode()));
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  const manifest = JSON.parse(byPath.get("manifest.json") ?? "{}") as Manifest;
  return { byPath, manifest };
};

const fieldsOf = (schema: z.ZodType) => Object.keys((schema as z.ZodObject).shape);

const landed = (
  { byPath, manifest }: ReturnType<typeof builtFiles>,
  landing: Landing,
  type: NodeType | "session",
  field: string,
) => {
  if ("file" in landing) {
    expect(byPath.get(landing.file), `${type}.${field} in ${landing.file}`).toContain(
      landing.shows,
    );
    return;
  }
  switch (landing.manifest) {
    case "node": {
      const node = manifest.nodes.find((each) => each.id === idOf[type as NodeType]);
      expect((node?.settings as Record<string, unknown>)[field], `${type}.${field}`).toEqual(
        landing.value,
      );
      return;
    }
    case "session":
      expect((manifest.session as Record<string, unknown>)[field], `session.${field}`).toEqual(
        landing.value,
      );
      return;
    case "inputs":
      expect(manifest.inputs, `${type}.${field}`).toEqual(landing.value);
      return;
    case "outputs":
      expect(manifest.outputs, `${type}.${field}`).toEqual([
        { node: "o", name: "M-output-name", type: "M-output-type" },
      ]);
      expect(JSON.stringify(manifest.outputs)).toContain(String(landing.value));
  }
};

describe("every setting lands in the build", () => {
  it("covers every field of every node type and of the session", () => {
    for (const type of Object.keys(registry) as NodeType[]) {
      expect(Object.keys(settings[type]).sort(), type).toEqual(
        fieldsOf(registry[type].settings).sort(),
      );
    }
    expect(Object.keys(session).sort()).toEqual(
      fieldsOf(Session)
        .filter((field) => field !== "frame")
        .sort(),
    );
  });

  it.each(
    Object.entries(settings).flatMap(([type, fields]) =>
      Object.entries(fields).map(([field, [, landing]]) => [type, field, landing] as const),
    ),
  )("%s.%s", (type, field, landing) => {
    landed(builtFiles(), landing, type as NodeType, field);
  });

  it.each(Object.entries(session).map(([field, [, landing]]) => [field, landing] as const))(
    "session.%s",
    (field, landing) => {
      landed(builtFiles(), landing, "session", field);
    },
  );

  it("puts no prompt or agent text only in the manifest", () => {
    const { byPath } = builtFiles();
    const claudeFiles = [...byPath]
      .filter(([path]) => path !== "manifest.json")
      .map(([, content]) => content)
      .join("\n");

    for (const marker of [
      "M-prompt-instructions",
      "M-prompt-output",
      "M-agent-given.md",
      "M-agent-writes.md",
    ]) {
      expect(claudeFiles).toContain(marker);
    }
  });
});
