import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { emit } from "../../../src/core/compiler/emit.js";
import { lower, type Manifest } from "../../../src/core/compiler/lower.js";
import {
  FlowSettings,
  parseFlow,
  SessionContainer,
  type NodeType,
} from "../../../src/core/flow/schema.js";
import { registry } from "../../../src/core/nodes/registry.js";

type Landing =
  | { file: string; shows: string }
  | { manifest: "node"; value: unknown }
  | { manifest: "session"; at: string[]; value: unknown }
  | { manifest: "settings"; value: unknown }
  | { manifest: "outputs"; value: unknown };

const inFile = (file: string, shows: string): Landing => ({ file, shows });
const atRunTime = (value: unknown): Landing => ({ manifest: "node", value });

const settings: Record<NodeType, Record<string, [unknown, Landing]>> = {
  agent: {
    role: ["M-agent-role", inFile("plugin/agents/label-agent.md", "M-agent-role")],
    instructions: [
      "M-agent-instructions",
      inFile("plugin/agents/label-agent.md", "M-agent-instructions"),
    ],
    model: ["M-agent-model", inFile("plugin/agents/label-agent.md", "M-agent-model")],
    given: [["M-agent-given.md"], inFile("plugin/agents/label-agent.md", "M-agent-given.md")],
    writes: [["M-agent-writes.md"], inFile("plugin/agents/label-agent.md", "M-agent-writes.md")],
    produces: ["M-agent-produces", atRunTime("M-agent-produces")],
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
  trigger: {},
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
    decidedBy: ["variable", atRunTime("variable")],
    variable: ["M-variable", atRunTime("M-variable")],
    value: ["M-branch-value", atRunTime("M-branch-value")],
  },
};

const inSession = (at: string[], value: unknown): Landing => ({ manifest: "session", at, value });

const session: Record<string, [unknown, Landing]> = {
  name: ["M-session-name", inSession(["name"], "M-session-name")],
  repo: ["/M-session-repo", inSession(["buildConfig", "repo"], "/M-session-repo")],
  branch: ["M-session-branch", inSession(["buildConfig", "base"], "M-session-branch")],
  model: ["M-session-model", inSession(["model"], "M-session-model")],
};

const containerKeys = ["id", "kind", "nodes"];

const blueprintSettings: Record<string, [unknown, Landing]> = {
  buildModel: ["M-build-model", { manifest: "settings", value: "M-build-model" }],
  permissionMode: ["M-permission-mode", inFile("settings.json", "M-permission-mode")],
};

const idOf: Record<NodeType, string> = {
  agent: "a",
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
    containers: [
      { id: "workspace-1", kind: "workspace", model: "sonnet", nodes: [] },
      {
        id: "session-1",
        kind: "session",
        ...valuesOf(session),
        nodes: Object.values(idOf),
      },
    ],
    settings: valuesOf(blueprintSettings),
  });

const builtFiles = () => {
  const target = {
    repo: "/M-build-repo",
    base: "M-build-base",
    branch: "flowdeck/M-build",
    branchCreated: true,
    workspace: "/M-build-workspace",
  };
  const files = emit(
    lower(everyNode(), {
      name: "M-build",
      values: { "M-variable": true },
      repo: target.repo,
      workspace: target.workspace,
    }),
    target,
  );
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  const manifest = JSON.parse(byPath.get("manifest.json") ?? "{}") as Manifest;
  return { byPath, manifest };
};

const fieldsOf = (schema: z.ZodType) => Object.keys((schema as z.ZodObject).shape);

const landed = (
  { byPath, manifest }: ReturnType<typeof builtFiles>,
  landing: Landing,
  type: NodeType | "session" | "settings",
  field: string,
) => {
  if ("file" in landing) {
    expect(byPath.get(landing.file) ?? "", `${type}.${field} in ${landing.file}`).toContain(
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
    case "session": {
      const value = landing.at.reduce<unknown>(
        (inside, key) => (inside as Record<string, unknown> | undefined)?.[key],
        manifest.session,
      );
      expect(value, `session.${field}`).toEqual(landing.value);
      return;
    }
    case "settings":
      expect(
        (manifest as unknown as { settings?: Record<string, unknown> }).settings?.[field],
        `settings.${field}`,
      ).toEqual(landing.value);
      return;
    case "outputs":
      expect(manifest.outputs, `${type}.${field}`).toEqual([
        { node: "o", name: "M-output-name", type: "M-output-type" },
      ]);
      expect(JSON.stringify(manifest.outputs)).toContain(String(landing.value));
  }
};

describe("every setting lands in the build", () => {
  it("covers every field of every node type, of the session container and of the blueprint's settings", () => {
    for (const type of Object.keys(registry) as NodeType[]) {
      expect(Object.keys(settings[type]).sort(), type).toEqual(
        fieldsOf(registry[type].settings).sort(),
      );
    }
    expect(Object.keys(session).sort()).toEqual(
      fieldsOf(SessionContainer)
        .filter((field) => !containerKeys.includes(field))
        .sort(),
    );
    expect(Object.keys(blueprintSettings).sort()).toEqual(fieldsOf(FlowSettings).sort());
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

  it.each(
    Object.entries(blueprintSettings).map(([field, [, landing]]) => [field, landing] as const),
  )("settings.%s", (field, landing) => {
    landed(builtFiles(), landing, "settings", field);
  });

  it("puts no agent text only in the manifest", () => {
    const { byPath } = builtFiles();
    const claudeFiles = [...byPath]
      .filter(([path]) => path !== "manifest.json")
      .map(([, content]) => content)
      .join("\n");

    for (const marker of ["M-agent-instructions", "M-agent-given.md", "M-agent-writes.md"]) {
      expect(claudeFiles).toContain(marker);
    }
  });
});
