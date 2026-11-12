import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { layDown, type LayDownDeps } from "../../src/core/compiler/build.js";
import { parseBuildReport } from "../../src/core/compiler/build-report.js";
import { checkBuild } from "../../src/core/compiler/check-build.js";
import type { BuildFile, Manifest } from "../../src/core/compiler/lower.js";
import { pieceMarker, type AgentCall } from "../../src/core/run/agent-calls.js";
import type { Flow } from "../../src/core/flow/schema.js";
import { agent, onMainFlow, thenWire } from "../fixtures/flow-builders.js";
import { FakeBuildAgents, type FakeBuildScript } from "./fake-build-agents.js";
import { FakeFileSystem } from "./fake-file-system.js";

const home = "/fd-home";
const workspaceDir = `${home}/workspaces/b-alpha-0001`;
const sessionName = "fd-build-alpha";

const deps: LayDownDeps = {
  home,
  workspace: {
    id: "b-alpha-0001",
    name: "alpha",
    repo: "/work/carousell-web",
    base: "main",
    values: {},
  },
};

const labelled = <T extends { label: string }>(node: T, label: string): T => ({ ...node, label });

const sample = (): Flow => {
  const base = onMainFlow(
    [
      labelled(agent("p", { settings: { writes: ["spec.md"] } }), "Draft the spec"),
      labelled(
        agent("a", { settings: { tools: ["Grep"], given: ["spec.md"] } }),
        "Review the draft",
      ),
      labelled(agent("s"), "Ship it"),
    ],
    [thenWire("p", "a"), thenWire("a", "s")],
  );
  return { ...base, session: { ...base.session, allowedTools: ["Read", "Edit", "Grep"] } };
};

const openSpec = {
  sessionName,
  claudeSessionId: "claude-session-1",
  workspaceDir,
  kitDir: `${home}/kit`,
  settingsPath: `${home}/build-sessions/b-alpha-0001/settings.json`,
  model: "haiku",
  env: { FLOWDECK_SOCK: `${home}/sock/${sessionName}.sock` },
};

type Laid = { fs: FakeFileSystem; source: Flow; laidDown: BuildFile[]; manifest: Manifest };

const laid = async (): Promise<Laid> => {
  const source = sample();
  const result = await layDown(source, deps);
  expect(result.ok).toBe(true);
  const laidDown = result.ok ? result.files : [];
  const manifest = JSON.parse(
    laidDown.find((file) => file.path === "manifest.json")?.content ?? "{}",
  ) as Manifest;
  const fs = new FakeFileSystem(
    Object.fromEntries(laidDown.map((file) => [join(workspaceDir, file.path), file.content])),
  );
  return { fs, source, laidDown, manifest };
};

const pieceFiles = (manifest: Manifest): string[] => [
  ...new Set(
    manifest.nodes.flatMap((node) =>
      node.file !== undefined && node.type === "agent" ? [node.file] : [],
    ),
  ),
];

const agentFile = (manifest: Manifest): string =>
  manifest.nodes.find((node) => node.id === "a")?.file ?? "";

const turnText = (paths: readonly string[]) => paths.map(pieceMarker).join("\n\n");

const readBack = async ({ fs, laidDown }: Laid): Promise<BuildFile[]> =>
  Promise.all(
    laidDown.map(async (file) => ({
      path: file.path,
      content: await fs.readFile(join(workspaceDir, file.path)),
    })),
  );

const check = async (state: Laid) =>
  checkBuild({
    laidDown: state.laidDown,
    readBack: await readBack(state),
    manifest: state.manifest,
    flow: state.source,
    shared: [],
  });

const openWith = async (state: Laid, script?: FakeBuildScript) => {
  const agents = new FakeBuildAgents({ fs: state.fs, ...(script ? { script } : {}) });
  await agents.open(openSpec);
  return agents;
};

const noCalls = () => undefined;

describe("FakeBuildAgents", () => {
  it("records open, turn and close calls in order", async () => {
    const state = await laid();
    const agents = await openWith(state);
    const first = turnText([agentFile(state.manifest)]);

    await agents.turn(sessionName, first, noCalls);
    await agents.turn(sessionName, "PIECE workspace", noCalls);
    await agents.close(sessionName);

    expect(agents.opened).toEqual([openSpec]);
    expect(agents.turns).toEqual([
      { sessionName, text: first },
      { sessionName, text: "PIECE workspace" },
    ]);
    expect(agents.closed).toEqual([sessionName]);
  });

  it("reports a running call and then a done call for each piece named in the turn", async () => {
    const state = await laid();
    const agents = await openWith(state);
    const pieces = pieceFiles(state.manifest);
    expect(pieces.length).toBeGreaterThan(1);
    const calls: AgentCall[] = [];

    const result = await agents.turn(sessionName, turnText(pieces), (call) => calls.push(call));

    expect(result).toEqual({ kind: "stopped" });
    expect(calls.map((call) => [call.piece, call.status])).toEqual(
      pieces.flatMap((piece) => [
        [piece, undefined],
        [piece, "completed"],
      ]),
    );
  });

  it("fills every named piece so the step-5 checker passes the workspace", async () => {
    const state = await laid();
    expect((await check(state)).length).toBeGreaterThan(0);
    const agents = await openWith(state);

    await agents.turn(sessionName, turnText(pieceFiles(state.manifest)), noCalls);

    expect(await check(state)).toEqual([]);
    for (const path of pieceFiles(state.manifest)) {
      expect(await state.fs.readFile(join(workspaceDir, path))).not.toContain("@unfilled");
    }
  });

  it("fills only the pieces the turn names", async () => {
    const state = await laid();
    const agents = await openWith(state);
    const [named = "", ...unnamed] = pieceFiles(state.manifest);
    expect(unnamed.length).toBeGreaterThan(0);

    await agents.turn(sessionName, turnText([named]), noCalls);

    const failing = new Set((await check(state)).map((failure) => failure.file));
    expect(failing.has(named)).toBe(false);
    for (const path of unnamed) expect(failing.has(path)).toBe(true);
  });

  it("names a piece with no file without writing one", async () => {
    const state = await laid();
    const agents = await openWith(state);
    const calls: AgentCall[] = [];

    await agents.turn(sessionName, "PIECE workspace", (call) => calls.push(call));

    expect(calls.map((call) => [call.piece, call.status])).toEqual([
      ["workspace", undefined],
      ["workspace", "completed"],
    ]);
    expect(await state.fs.exists(join(workspaceDir, "workspace"))).toBe(false);
  });

  it("leaves the @unfilled line on a scripted piece in the scripted round, and fills it after", async () => {
    const state = await laid();
    const target = agentFile(state.manifest);
    const agents = await openWith(state, { leaveMarker: [{ path: target, rounds: [1] }] });
    const all = turnText(pieceFiles(state.manifest));

    await agents.turn(sessionName, all, noCalls);
    const roundOne = await check(state);
    expect(roundOne.filter((failure) => failure.rule === "unfilled").map((f) => f.file)).toEqual([
      target,
    ]);

    await agents.turn(sessionName, turnText([target]), noCalls);
    expect(await check(state)).toEqual([]);
  });

  it("leaves the @unfilled line in every round when no rounds are scripted", async () => {
    const state = await laid();
    const target = agentFile(state.manifest);
    const agents = await openWith(state, { leaveMarker: [{ path: target }] });

    await agents.turn(sessionName, turnText(pieceFiles(state.manifest)), noCalls);
    await agents.turn(sessionName, turnText([target]), noCalls);
    await agents.turn(sessionName, turnText([target]), noCalls);

    expect((await check(state)).map((failure) => [failure.file, failure.rule])).toEqual([
      [target, "unfilled"],
    ]);
  });

  it("edits a code-owned file in the scripted round, so step 5 names it", async () => {
    const state = await laid();
    const agents = await openWith(state, {
      editCodeOwned: [{ path: "settings.json", rounds: [1] }],
    });

    await agents.turn(sessionName, turnText(pieceFiles(state.manifest)), noCalls);

    expect(await check(state)).toEqual([
      expect.objectContaining({ file: "settings.json", rule: "code-owned" }),
    ]);
  });

  it("edits a code-owned file in every round when no rounds are scripted", async () => {
    const state = await laid();
    const path = join(workspaceDir, "settings.json");
    const agents = await openWith(state, { editCodeOwned: [{ path: "settings.json" }] });
    const pieces = turnText(pieceFiles(state.manifest));

    await agents.turn(sessionName, pieces, noCalls);
    const afterOne = await state.fs.readFile(path);
    await state.fs.writeFile(
      path,
      state.laidDown.find((f) => f.path === "settings.json")?.content ?? "",
    );
    await agents.turn(sessionName, pieces, noCalls);

    expect(afterOne).not.toBe(state.laidDown.find((f) => f.path === "settings.json")?.content);
    expect((await check(state)).map((failure) => failure.file)).toEqual(["settings.json"]);
  });

  it("writes the scripted questions, merges and keptApart into build-report.json", async () => {
    const state = await laid();
    const script: FakeBuildScript = {
      questions: [{ nodeId: "a", text: "Which branch does the review read?" }],
      merges: [{ nodeIds: ["p", "s"], reason: "Same job" }],
      keptApart: [{ nodeIds: ["a", "s"], reason: "Different jobs" }],
    };
    const agents = await openWith(state, script);

    await agents.turn(sessionName, turnText(pieceFiles(state.manifest)), noCalls);

    const report = parseBuildReport(
      await state.fs.readFile(join(workspaceDir, "build-report.json")),
    );
    expect(report.questions).toEqual(script.questions);
    expect(report.merges).toEqual(script.merges);
    expect(report.keptApart).toEqual(script.keptApart);
  });

  it("fails the turn with the scripted reason", async () => {
    const state = await laid();
    const agents = await openWith(state, { failTurn: "StopFailure: rate limited" });

    const result = await agents.turn(sessionName, turnText([agentFile(state.manifest)]), noCalls);

    expect(result).toEqual({ kind: "failed", reason: "StopFailure: rate limited" });
    expect(agents.turns).toHaveLength(1);
  });

  it("reads an open session as alive and a closed one as not", async () => {
    const state = await laid();
    const agents = await openWith(state);

    expect(await agents.alive(sessionName)).toBe(true);
    await agents.close(sessionName);
    expect(await agents.alive(sessionName)).toBe(false);
  });

  it("reads a session it never opened as alive only when scripted alive after a restart", async () => {
    const state = await laid();

    expect(await new FakeBuildAgents({ fs: state.fs }).alive(sessionName)).toBe(false);
    expect(
      await new FakeBuildAgents({ fs: state.fs, script: { aliveAfterRestart: true } }).alive(
        sessionName,
      ),
    ).toBe(true);
  });
});
