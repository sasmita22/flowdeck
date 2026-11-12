import { describe, expect, it } from "vitest";
import { parseFlow } from "../../../src/core/flow/schema.js";
import { upgradeFlow } from "../../../src/core/flow/upgrade.js";
import { agent, fileWire, thenWire } from "../../fixtures/flow-builders.js";

type RawNode = { id: string; type: string; settings: Record<string, unknown> };
type RawFlow = { nodes: RawNode[]; session: Record<string, unknown> };

const sessionBase = {
  name: "main",
  model: "sonnet",
  allowedTools: [],
  permissionMode: "default",
  connectors: [],
};

const node = (id: string, type: string, settings: Record<string, unknown>) => ({
  id,
  label: id,
  position: { x: 0, y: 0 },
  type,
  settings,
});

const oldFlow = ({
  inputs = [] as string[],
  flags = {} as Record<string, unknown>,
  workingFolder = { kind: "worktree", branch: "main" } as Record<string, unknown>,
  extra = [] as ReturnType<typeof node>[],
} = {}) => ({
  nodes: [node("start", "trigger", { inputs, flags }), ...extra],
  wires: [],
  session: { ...sessionBase, workingFolder },
});

const upgraded = (raw: unknown) => upgradeFlow(raw) as RawFlow;

const buildConfigOf = (raw: unknown) => upgraded(raw).session.buildConfig;

const nodeById = (flow: RawFlow, id: string) => flow.nodes.find((n) => n.id === id);

describe("upgradeFlow on an old blueprint", () => {
  it("turns Trigger inputs into text variables with no default", () => {
    expect(buildConfigOf(oldFlow({ inputs: ["ticket", "scope"] }))).toMatchObject({
      variables: [
        { name: "ticket", kind: "text" },
        { name: "scope", kind: "text" },
      ],
    });
    const variables = (buildConfigOf(oldFlow({ inputs: ["ticket"] })) as { variables: object[] })
      .variables;
    expect(variables[0]).not.toHaveProperty("default");
  });

  it("turns boolean Trigger flags into yes/no variables with that default", () => {
    expect(buildConfigOf(oldFlow({ flags: { e2e: true, dryRun: false } }))).toMatchObject({
      variables: [
        { name: "e2e", kind: "yesno", default: true },
        { name: "dryRun", kind: "yesno", default: false },
      ],
    });
  });

  it.each([
    ["a string", "staging", "staging"],
    ["a number", 3, "3"],
    ["zero", 0, "0"],
    ["an empty string", "", ""],
  ])(
    "turns a Trigger flag holding %s into a text variable defaulting to its text",
    (_, value, text) => {
      expect(buildConfigOf(oldFlow({ flags: { env: value } }))).toMatchObject({
        variables: [{ name: "env", kind: "text", default: text }],
      });
    },
  );

  it("keeps every input and every flag as a variable", () => {
    const variables = (
      buildConfigOf(oldFlow({ inputs: ["ticket"], flags: { e2e: true, env: "prod" } })) as {
        variables: unknown[];
      }
    ).variables;

    expect(variables).toHaveLength(3);
    expect(variables).toEqual(
      expect.arrayContaining([
        { name: "ticket", kind: "text" },
        { name: "e2e", kind: "yesno", default: true },
        { name: "env", kind: "text", default: "prod" },
      ]),
    );
  });

  it("moves a worktree folder's repo and branch to the Build configuration's repo and base", () => {
    expect(
      buildConfigOf(
        oldFlow({ workingFolder: { kind: "worktree", branch: "dev", repo: "/r/shop" } }),
      ),
    ).toEqual({ repo: "/r/shop", base: "dev", variables: [] });
  });

  it("moves a worktree folder with no repo to a base and no repo", () => {
    const config = buildConfigOf(oldFlow({ workingFolder: { kind: "worktree", branch: "main" } }));

    expect(config).toEqual({ base: "main", variables: [] });
    expect((config as { repo?: unknown }).repo).toBeUndefined();
  });

  it("moves a plain folder to no repo", () => {
    const config = buildConfigOf(oldFlow({ workingFolder: { kind: "path", path: "/r/shop" } }));

    expect((config as { repo?: unknown }).repo).toBeUndefined();
    expect(config).toMatchObject({ variables: [] });
  });

  it("points a Branch on an old flag at the variable of the same name", () => {
    const flow = upgraded(
      oldFlow({ flags: { e2e: true }, extra: [node("b", "branch", { flag: "e2e" })] }),
    );

    expect(nodeById(flow, "b")?.settings).toEqual({ variable: "e2e" });
  });

  it("leaves the Trigger with no inputs or flags and the session with no working folder", () => {
    const flow = upgraded(oldFlow({ inputs: ["ticket"], flags: { e2e: true } }));

    expect(nodeById(flow, "start")?.settings).not.toHaveProperty("inputs");
    expect(nodeById(flow, "start")?.settings).not.toHaveProperty("flags");
    expect(flow.session).not.toHaveProperty("workingFolder");
  });

  it("keeps the rest of the session and the other nodes as they were", () => {
    const prompt = node("p", "prompt", { instructions: "Hi" });
    const flow = upgraded({
      ...oldFlow({ extra: [prompt] }),
      session: { ...oldFlow().session, budget: 2 },
    });

    expect(flow.session).toMatchObject({ ...sessionBase, budget: 2 });
    expect(nodeById(flow, "p")).toEqual(prompt);
  });
});

describe("upgradeFlow on the old Start and Stop names", () => {
  const labelled = (id: string, type: string, label: string) => ({ ...node(id, type, {}), label });
  const labelOf = (raw: ReturnType<typeof labelled>) =>
    (
      upgradeFlow({ nodes: [raw], wires: [], session: sessionBase }) as {
        nodes: { label: string }[];
      }
    ).nodes[0]?.label;

  it.each([
    ["a trigger labelled Trigger", "trigger", "Trigger", "Start"],
    ["an output labelled Output", "output", "Output", "Stop"],
    ["a trigger labelled Kickoff", "trigger", "Kickoff", "Kickoff"],
    ["a prompt labelled Trigger", "prompt", "Trigger", "Trigger"],
    ["a prompt labelled Output", "prompt", "Output", "Output"],
    ["an output labelled Done", "output", "Done", "Done"],
  ])("keeps or renames the label of %s", (_, type, label, expected) => {
    expect(labelOf(labelled("n", type, label))).toBe(expected);
  });
});

describe("upgradeFlow on a blueprint already in the new shape", () => {
  const current = {
    nodes: [
      node("start", "trigger", {}),
      node("b", "branch", { variable: "e2e" }),
      node("p", "prompt", { instructions: "Fix {{ticket}}" }),
    ],
    wires: [],
    session: {
      ...sessionBase,
      buildConfig: {
        repo: "/r/shop",
        base: "main",
        variables: [
          { name: "e2e", kind: "yesno", default: true },
          { name: "ticket", kind: "text" },
        ],
      },
    },
  };

  it("returns it unchanged", () => {
    expect(upgradeFlow(structuredClone(current))).toEqual(current);
  });

  it("gives the same result when run twice on an old blueprint", () => {
    const old = oldFlow({
      inputs: ["ticket"],
      flags: { e2e: true },
      workingFolder: { kind: "worktree", branch: "dev", repo: "/r" },
      extra: [node("b", "branch", { flag: "e2e" })],
    });
    const once = upgradeFlow(structuredClone(old));

    expect(upgradeFlow(structuredClone(once))).toEqual(once);
  });
});

describe("parseFlow on a saved blueprint", () => {
  const saved = (nodes: unknown[], wires: unknown[]) => ({
    nodes,
    wires,
    session: {
      ...sessionBase,
      buildConfig: {
        base: "main",
        variables: [{ name: "e2e", kind: "yesno", default: true }],
      },
    },
  });

  const settingsOf = (flow: { nodes: { id: string; settings: object }[] }, id: string) =>
    flow.nodes.find((n) => n.id === id)?.settings;

  it("turns a Plan to Build File wire into Plan writes and Build given, with no wire left", () => {
    const flow = parseFlow(
      saved(
        [agent("plan"), agent("build")],
        [thenWire("plan", "build"), fileWire("plan", "build", "plan.md")],
      ),
    );

    expect(settingsOf(flow, "plan")).toMatchObject({ writes: ["plan.md"] });
    expect(settingsOf(flow, "build")).toMatchObject({ given: ["plan.md"] });
    expect(flow.wires).toEqual([thenWire("plan", "build")]);
  });

  it("does not repeat a file the Agents already name", () => {
    const flow = parseFlow(
      saved(
        [
          agent("plan", { settings: { writes: ["plan.md"] } }),
          agent("build", { settings: { given: ["plan.md"] } }),
        ],
        [fileWire("plan", "build", "plan.md")],
      ),
    );

    expect(settingsOf(flow, "plan")).toMatchObject({ writes: ["plan.md"] });
    expect(settingsOf(flow, "build")).toMatchObject({ given: ["plan.md"] });
    expect(flow.wires).toEqual([]);
  });

  it.each([
    ["a variable", { variable: "e2e" }],
    ["a pre-upgrade flag", { flag: "e2e" }],
  ])("loads a Branch on %s with no decidedBy", (_, settings) => {
    const flow = parseFlow(saved([node("b", "branch", settings)], []));

    expect(settingsOf(flow, "b")).toEqual({ variable: "e2e" });
  });
});
