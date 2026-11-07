import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ClaudeBuildAgents } from "../../src/adapters/claude/claude-build-agents.js";
import { TmuxSessionHost } from "../../src/adapters/tmux/tmux-session-host.js";
import { prepareKit } from "../../src/adapters/node-fs/kit-copy.js";
import { realDeps } from "../../src/cli/main.js";
import { buildReportSchema } from "../../src/core/compiler/build-report.js";
import {
  buildSessionSettings,
  newBuildSessionName,
} from "../../src/core/compiler/build-session.js";
import { hookCommand, shellQuote } from "../../src/core/compiler/hook-settings.js";
import type { Manifest, ManifestNode } from "../../src/core/compiler/lower.js";
import { pieceNames } from "../../src/core/compiler/pieces.js";
import { scopeLine, scopeOf } from "../../src/core/compiler/scope-line.js";
import { parseFlow, type Flow } from "../../src/core/flow/schema.js";
import type { Handoff } from "../../src/core/flow/handoff.js";
import { agentPrompt } from "../../src/core/nodes/agent/execute.js";
import { cliBuild, plannedWorkspace } from "../fixtures/cli-build.js";
import { flow as builderFlow, prompt } from "../fixtures/flow-builders.js";
import { killTmuxServer, removeClaudeSessions, sleep } from "../fixtures/live-claude.js";
import {
  draftsOnly,
  LiveBuilds,
  realBuildAgents,
  type LiveBuildResult,
} from "../fixtures/live-build.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const run = promisify(execFile);
const kitSourceDir = fileURLToPath(new URL("../../kit", import.meta.url));
const buildTimeoutMs = 900_000;
const descriptionFloor = 60;
const gate = "npm run gate:sample";

const kitSkills = [
  "audit-duplicates",
  "audit-handoffs",
  "audit-orchestrator",
  "fit-to-repo",
  "write-agent",
  "write-handoff-template",
  "write-script",
  "write-skill",
  "write-step",
  "write-workspace-rules",
];
const madeUpSkill = "write-nothing-at-all";

const sampleRepo: Record<string, string> = {
  "CLAUDE.md": [
    "# Sample",
    "",
    "## Gates",
    "",
    `Before a change is done, run \`${gate}\`. It is this repo's only gate.`,
    "",
    "## Tests",
    "",
    "Each module `src/<name>.js` has its unit tests in `src/<name>.test.js`, one `test(...)` per exported function, run by the gate.",
    "",
    "## Branches",
    "",
    "The repo has no remote. Work happens on a branch cut from the local `main`, and is brought up to date with `git merge main`.",
    "",
  ].join("\n"),
  "package.json": `${JSON.stringify(
    { name: "sample", private: true, scripts: { "gate:sample": "node --test src" } },
    null,
    2,
  )}\n`,
  "README.md": [
    "# Sample",
    "",
    "- [Greeting code](src/greet.js)",
    "- [Setup guide](docs/setup.md)",
    "",
  ].join("\n"),
  "src/greet.js": [
    "export function greet(name) {",
    "  return `Hello, ${name}`;",
    "}",
    "",
    "export function farewell(name) {",
    "  return `Bye, ${nam}`;",
    "}",
    "",
  ].join("\n"),
  "src/greet.test.js": [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { greet } from "./greet.js";',
    "",
    'test("greet", () => assert.equal(greet("Ann"), "Hello, Ann"));',
    "",
  ].join("\n"),
};

async function seedSampleRepo(path: string): Promise<void> {
  for (const [file, content] of Object.entries(sampleRepo)) {
    await mkdir(dirname(join(path, file)), { recursive: true });
    await writeFile(join(path, file), content);
  }
  await run("git", ["add", "."], { cwd: path });
  await run(
    "git",
    [
      "-c",
      "user.name=Flowdeck Test",
      "-c",
      "user.email=test@flowdeck.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "sample",
    ],
    { cwd: path },
  );
}

type AgentSpec = {
  id: string;
  label: string;
  instructions: string;
  tools: string[];
  writes?: string[];
};

const at = (x: number) => ({ x, y: 0 });
const then = (from: string, to: string) => ({
  kind: "then",
  from: { node: from, port: "out" },
  to: { node: to, port: "in" },
});

function liveFlow(
  steps: (
    | ({ type: "agent" } & AgentSpec)
    | { type: "prompt"; id: string; label: string; instructions: string }
  )[],
  allowedTools: string[],
  files: { from: string; to: string; file: string }[] = [],
): Flow {
  const ids = ["t", ...steps.map((step) => step.id)];
  return parseFlow({
    nodes: [
      { id: "t", label: "Start", type: "trigger", position: at(0), settings: {} },
      ...steps.map((step, index) =>
        step.type === "prompt"
          ? {
              id: step.id,
              label: step.label,
              type: "prompt",
              position: at(index + 1),
              settings: { instructions: step.instructions },
            }
          : {
              id: step.id,
              label: step.label,
              type: "agent",
              position: at(index + 1),
              settings: {
                role: "",
                instructions: step.instructions,
                model: "haiku",
                tools: step.tools,
                ...(step.writes === undefined ? {} : { writes: step.writes }),
              },
            },
      ),
    ],
    wires: [
      ...ids.slice(1).map((id, index) => then(ids[index] ?? "", id)),
      ...files.map(({ from, to, file }) => ({
        kind: "file",
        from: { node: from, port: "file-out" },
        to: { node: to, port: "file-in" },
        file,
      })),
    ],
    session: {
      name: "main",
      buildConfig: { base: "main", variables: [], buildModel: "haiku" },
      model: "haiku",
      allowedTools,
      permissionMode: "acceptEdits",
      connectors: [],
    },
  });
}

const agentFile = (flow: Flow, nodeId: string) =>
  `plugin/agents/${pieceNames(flow).get(nodeId)}.md`;

const contentOf = (built: LiveBuildResult, path: string): string => {
  const content = built.files.get(path);
  if (content === undefined)
    throw new Error(`${path} was not in the workspace when the session closed`);
  return content;
};

function descriptionOf(content: string): string {
  const raw = /^description: (.*)$/m.exec(content)?.[1] ?? "";
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : raw;
  } catch {
    return raw;
  }
}

function afterScope(description: string): string {
  const parts = scopeOf(description);
  return (parts === undefined ? description : description.slice(scopeLine(parts).length)).trim();
}

const fold = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

const manifestOf = (built: LiveBuildResult): Manifest =>
  JSON.parse(contentOf(built, "manifest.json")) as Manifest;

const nodeOf = (manifest: Manifest, id: string): ManifestNode => {
  const node = manifest.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`no manifest node ${id}`);
  return node;
};

const detailsOf = (node: ManifestNode): string => {
  const { given = [], writes = [] } = node.settings as Partial<Handoff>;
  return agentPrompt({ id: node.id, given, writes });
};

const endReport = (built: LiveBuildResult) => buildReportSchema.parse(built.ends.at(-1)?.report);

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("build agents with real claude", () => {
  let home: string;
  let repo: TmpRepo;
  let builds: LiveBuilds;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "fd-build-agents-")));
    repo = await createTmpRepo({ commit: true });
    await seedSampleRepo(repo.path);
    builds = new LiveBuilds(home);
  });

  afterEach(async () => {
    await builds.cleanup();
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  }, 120_000);

  describe("AT-4", () => {
    it(
      "gives an agent labelled 'sync with base branch' a description that says what it does and when",
      { timeout: buildTimeoutMs },
      async () => {
        const flow = liveFlow(
          [
            {
              type: "agent",
              id: "a1",
              label: "sync with base branch",
              instructions:
                "Bring this branch up to date with the base branch: merge the local main branch in, and stop on a conflict.",
              tools: ["Bash"],
            },
          ],
          ["Bash"],
        );

        const built = await builds.build(flow, { name: "live-at4", repo: repo.path });

        const after = afterScope(descriptionOf(contentOf(built, agentFile(flow, "a1"))));
        console.log(`description after the scope line: ${JSON.stringify(after)}`);
        expect.soft(built.ends.at(-1)?.outcome).toBe("built");
        expect(fold(after)).not.toBe(fold("sync with base branch"));
        expect(after.length).toBeGreaterThanOrEqual(descriptionFloor);
        expect(after).toMatch(/\b(base|main)\b/i);
        expect(after).toMatch(/\b(sync|merge|rebase|update|up to date)/i);
        expect(after).toMatch(/\b(when|after|before)\b/i);
      },
    );
  });

  describe("AT-5", () => {
    it(
      "quotes the sample repo's own gate command in the 'Review code' piece",
      { timeout: buildTimeoutMs },
      async () => {
        const flow = liveFlow(
          [
            {
              type: "agent",
              id: "a1",
              label: "Review code",
              instructions:
                "Review the code under src/ and write the problems you find to review.md.",
              tools: ["Read", "Grep", "Glob", "Bash", "Write"],
              writes: ["review.md"],
            },
            {
              type: "prompt",
              id: "p1",
              label: "Share review",
              instructions: "Read review.md and reply with its first problem in one line.",
            },
          ],
          ["Read", "Grep", "Glob", "Bash", "Write"],
          [{ from: "a1", to: "p1", file: "review.md" }],
        );
        expect(JSON.stringify(flow)).not.toContain(gate);

        const built = await builds.build(flow, { name: "live-at5", repo: repo.path });

        expect.soft(built.ends.at(-1)?.outcome).toBe("built");
        expect(contentOf(built, agentFile(flow, "a1"))).toContain(gate);
      },
    );
  });

  describe("AT-6", () => {
    it(
      "ends needs-you when an agent reads notes.md that no node writes, naming the reader and the upstream node",
      { timeout: buildTimeoutMs },
      async () => {
        const flow = liveFlow(
          [
            {
              type: "prompt",
              id: "p1",
              label: "Take notes",
              instructions: "List the open questions about the login bug.",
            },
            {
              type: "agent",
              id: "a1",
              label: "Summarise notes",
              instructions: "Read notes.md and write a three-line summary of it to summary.md.",
              tools: ["Read", "Write"],
            },
          ],
          ["Read", "Write"],
        );

        const built = await builds.build(flow, { name: "live-at6", repo: repo.path });

        expect(built.ends.at(-1)?.outcome).toBe("needs-you");
        expect(endReport(built).questions).toContainEqual(
          expect.objectContaining({ nodeId: "a1", otherNodeId: "p1" }),
        );
      },
    );
  });

  describe("AT-7", () => {
    it(
      "merges two differently worded review agents into one piece that both nodes carry, each with its own details",
      { timeout: buildTimeoutMs },
      async () => {
        const flow = liveFlow(
          [
            {
              type: "agent",
              id: "a1",
              label: "Review greet.js",
              instructions: "Read src/greet.js and list any bugs you find.",
              tools: ["Read", "Grep", "Write"],
              writes: ["review-1.md"],
            },
            {
              type: "agent",
              id: "a2",
              label: "Look for defects",
              instructions: "Go over the code in src/greet.js and report the defects in it.",
              tools: ["Read", "Grep", "Write"],
              writes: ["review-2.md"],
            },
          ],
          ["Read", "Grep", "Write"],
        );

        const built = await builds.build(flow, { name: "live-at7", repo: repo.path });

        expect.soft(built.ends.at(-1)?.outcome).toBe("built");
        const manifest = manifestOf(built);
        const first = nodeOf(manifest, "a1");
        const second = nodeOf(manifest, "a2");
        expect(second.piece).toBe(first.piece);
        expect(second.file).toBe(first.file);
        expect(detailsOf(first)).toContain("review-1.md");
        expect(detailsOf(second)).toContain("review-2.md");
        expect(detailsOf(first)).not.toBe(detailsOf(second));
      },
    );
  });

  describe("AT-8", () => {
    it(
      "keeps two agents both labelled 'Check' with different jobs as two pieces, with the reason",
      { timeout: buildTimeoutMs },
      async () => {
        const flow = liveFlow(
          [
            {
              type: "agent",
              id: "a1",
              label: "Check",
              instructions:
                "Check that every exported function under src has a unit test, and list the ones that do not.",
              tools: ["Read", "Grep", "Glob"],
            },
            {
              type: "agent",
              id: "a2",
              label: "Check",
              instructions:
                "Check README.md for relative links to files that do not exist in the repo, and list them.",
              tools: ["Read", "Grep", "Glob"],
            },
          ],
          ["Read", "Grep", "Glob"],
        );

        const built = await builds.build(flow, { name: "live-at8", repo: repo.path });

        expect.soft(built.ends.at(-1)?.outcome).toBe("built");
        const manifest = manifestOf(built);
        expect(nodeOf(manifest, "a2").piece).not.toBe(nodeOf(manifest, "a1").piece);
        const keptApart = endReport(built).keptApart.find(
          (group) => group.nodeIds.includes("a1") && group.nodeIds.includes("a2"),
        );
        expect(keptApart?.reason.trim() ?? "").not.toBe("");
      },
    );
  });
});

describe.skipIf(process.env.FLOWDECK_LIVE !== "1" || draftsOnly)("AT-12 (live)", () => {
  const sessionName = newBuildSessionName(randomUUID);
  const claudeSessionId = randomUUID();
  let home: string;
  let repo: TmpRepo;
  let workspaceDir: string;
  let agents: ClaudeBuildAgents | undefined;

  beforeAll(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "fd-build-kit-")));
    repo = await createTmpRepo({ commit: true });
    const workspace = plannedWorkspace(home, repo.path);
    workspaceDir = workspace.dir;
    const real = realDeps();
    await cliBuild(
      builderFlow([prompt("p1")], []),
      { name: "live-kit", repo: repo.path },
      workspace,
      { ...real, env: { ...process.env, FLOWDECK_HOME: home } },
    );
    const kit = await prepareKit({ sourceDir: kitSourceDir, home });
    const settingsPath = join(home, "build-sessions", sessionName, "settings.json");
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify(
        buildSessionSettings({
          guardCommand: [real.hooks.nodePath, real.build.guardScriptPath, workspaceDir]
            .map(shellQuote)
            .join(" "),
          hookCommand: hookCommand(real.hooks),
        }),
      ),
    );
    agents = realBuildAgents(home);
    await agents.open({
      sessionName,
      claudeSessionId,
      workspaceDir,
      kitDir: kit.dir,
      settingsPath,
      model: "haiku",
      env: {},
    });
  }, 120_000);

  afterAll(async () => {
    await agents?.close(sessionName);
    await killTmuxServer(sessionName);
    await removeClaudeSessions(workspaceDir, [claudeSessionId]);
    await repo.cleanup();
    await rm(home, { recursive: true, force: true });
  }, 60_000);

  it(
    "offers each of the ten kit skills by its own name under /flowdeck-build:, and no made-up one",
    { timeout: 180_000 },
    async () => {
      const sessions = new TmuxSessionHost({ socketName: sessionName });
      const offered = (pane: string, skill: string) =>
        new RegExp(`${skill}\\s+\\(flowdeck-build\\)`).test(pane);
      const seen: string[] = [];
      const panes: string[] = [];
      for (const skill of [...kitSkills, madeUpSkill]) {
        await sessions.typeText(sessionName, `/flowdeck-build:${skill}`);
        let pane = await sessions.capture(sessionName);
        for (let waited = 0; waited < 10_000 && !offered(pane, skill); waited += 250) {
          await sleep(250);
          pane = await sessions.capture(sessionName);
        }
        if (offered(pane, skill)) seen.push(skill);
        panes.push(pane);
        await run("tmux", ["-L", sessionName, "send-keys", "-t", `=${sessionName}:`, "C-u"]);
        await sleep(500);
      }

      console.log(`panes:\n${panes.join("\n")}`);
      expect(seen).toEqual(kitSkills);
    },
  );
});
