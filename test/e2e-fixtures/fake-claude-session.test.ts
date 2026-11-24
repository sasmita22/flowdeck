import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFakeClaude } from "../../e2e/fake-claude.js";
import { ClaudeCli } from "../../src/adapters/claude/claude-cli.js";
import { TmuxSessionHost } from "../../src/adapters/tmux/tmux-session-host.js";
import { shellQuote } from "../../src/core/compiler/hook-settings.js";
import { lower } from "../../src/core/compiler/lower.js";
import { orchestratorSkill } from "../../src/core/compiler/orchestrator.js";
import { pieceNames } from "../../src/core/compiler/pieces.js";
import type { Flow } from "../../src/core/flow/schema.js";
import {
  agent,
  flow,
  fork,
  hardstop,
  join as joinNode,
  output,
  thenWire,
  trigger,
} from "../fixtures/flow-builders.js";
import { killTmuxServer } from "../fixtures/live-claude.js";

type HookEvent = {
  hook_event_name: string;
  tool_input?: { prompt?: string };
  last_assistant_message?: string;
};

const labelled = <T extends { label: string }>(node: T, label: string): T => ({ ...node, label });

const forkFlow = (): Flow =>
  flow(
    [
      labelled(trigger("t"), "Start"),
      labelled(fork("f"), "Fork"),
      labelled(agent("a"), "A"),
      labelled(agent("b"), "B"),
      labelled(joinNode("j"), "Join"),
      labelled(agent("c"), "C"),
      labelled(output("o"), "Stop"),
    ],
    [
      thenWire("t", "f"),
      thenWire("f", "a"),
      thenWire("f", "b"),
      thenWire("a", "j"),
      thenWire("b", "j"),
      thenWire("j", "c"),
      thenWire("c", "o"),
    ],
  );

const hardStopFlow = (): Flow =>
  flow(
    [
      labelled(trigger("t"), "Start"),
      labelled(agent("a"), "A"),
      labelled(hardstop("h"), "Guard"),
      labelled(agent("b"), "B"),
      labelled(output("o"), "Stop"),
    ],
    [thenWire("t", "a"), thenWire("a", "h"), thenWire("h", "b"), thenWire("b", "o")],
  );

const runSkillOf = (input: Flow) => {
  const scope = { build: "fork", repo: "repo", workspace: "/fd/workspaces/fork" };
  const { manifest } = lower(input, { name: scope.build, values: {} });
  const session = manifest.containers.find((container) => container.kind === "session");
  if (session === undefined) throw new Error("the flow has no session container");
  const pieces = pieceNames(input);
  const nodes = session.nodes.map((node) => {
    const piece = pieces.get(node.id);
    return piece === undefined ? node : { ...node, piece };
  });
  return orchestratorSkill(
    { ...session, nodes, orchestrator: "plugin/skills/run/SKILL.md" },
    scope,
  );
};

const labelOf = (event: HookEvent) => {
  const node = /^NODE (\S+)/.exec(event.tool_input?.prompt ?? "")?.[1];
  return node === undefined ? event.hook_event_name : `${event.hook_event_name} ${node}`;
};

const recordingSocket = (events: HookEvent[]) =>
  createServer((socket) => {
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (text += chunk));
    socket.on("end", () => {
      for (const line of text.split("\n")) {
        if (line.trim() !== "") events.push(JSON.parse(line) as HookEvent);
      }
    });
  });

describe("the fake Claude session", () => {
  const name = `fd-test-fake-session-${process.pid}`;
  let dir: string | undefined;
  let hooks: Server | undefined;

  afterEach(async () => {
    hooks?.close();
    hooks = undefined;
    await killTmuxServer(name);
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("shows the input box Claude's readiness check looks for", async () => {
    dir = await mkdtemp(join(tmpdir(), "fd-fake-session-"));
    const bin = join(dir, "bin");
    await writeFakeClaude(bin);
    const sessions = new TmuxSessionHost({ socketName: name });
    const command = [
      process.execPath,
      join(bin, "fake-claude.cjs"),
      "session",
      "--session-id",
      randomUUID(),
    ]
      .map(shellQuote)
      .join(" ");
    const sock = join(dir, "hooks.sock");
    hooks = createServer((socket) => socket.resume());
    await new Promise<void>((listening) => hooks?.listen(sock, listening));
    await sessions.start(name, dir, command, { FLOWDECK_SOCK: sock });

    const cli = new ClaudeCli({ sessions, readyTimeoutMs: 2000 });

    await expect(cli.waitUntilReady(name)).resolves.toBeUndefined();
  });

  const runFake = async (input: Flow, agentFiles: Record<string, string> = {}) => {
    dir = await mkdtemp(join(tmpdir(), "fd-fake-session-"));
    const bin = join(dir, "bin");
    await writeFakeClaude(bin);
    const skill = runSkillOf(input);
    await mkdir(dirname(join(dir, skill.path)), { recursive: true });
    await writeFile(join(dir, skill.path), skill.content);
    const pieces = pieceNames(input);
    for (const [nodeId, text] of Object.entries(agentFiles)) {
      const agents = join(dir, "plugin", "agents");
      await mkdir(agents, { recursive: true });
      await writeFile(join(agents, `${pieces.get(nodeId) ?? nodeId}.md`), text);
    }
    const sessions = new TmuxSessionHost({ socketName: name });
    const command = [
      process.execPath,
      join(bin, "fake-claude.cjs"),
      "session",
      "--session-id",
      randomUUID(),
      "--plugin-dir",
      join(dir, "plugin"),
      "/fork:run",
    ]
      .map(shellQuote)
      .join(" ");
    const sock = join(dir, "hooks.sock");
    const events: HookEvent[] = [];
    hooks = recordingSocket(events);
    await new Promise<void>((listening) => hooks?.listen(sock, listening));

    await sessions.start(name, dir, command, { FLOWDECK_SOCK: sock });

    await expect
      .poll(() => events.some((event) => event.hook_event_name === "Stop"), { timeout: 10_000 })
      .toBe(true);
    return events;
  };

  it("dispatches a Fork's branches as one batch before the steps after the Join", async () => {
    const events = await runFake(forkFlow());

    expect(
      events.filter((event) => event.hook_event_name !== "UserPromptSubmit").map(labelOf),
    ).toEqual([
      "PreToolUse a",
      "PreToolUse b",
      "PostToolUse a",
      "PostToolUse b",
      "PreToolUse c",
      "PostToolUse c",
      "Stop",
    ]);
  });

  it("stops at the hard stop after a node holding the hardstop verb", async () => {
    const events = await runFake(hardStopFlow(), { a: "fake: hardstop" });

    expect(
      events.filter((event) => event.hook_event_name !== "UserPromptSubmit").map(labelOf),
    ).toEqual(["PreToolUse a", "PostToolUse a", "Stop"]);
    expect(events.at(-1)?.last_assistant_message?.split("\n").at(-1)).toBe("STOPPED NODE h");
  });
});
