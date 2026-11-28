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
import { agentTurnText } from "../../src/core/nodes/agent/execute.js";
import { parseProducedValues } from "../../src/core/run/verdict.js";
import {
  agent,
  branch,
  flow,
  fork,
  gate,
  join as joinNode,
  output,
  thenWire,
  trigger,
  wire,
} from "../fixtures/flow-builders.js";
import { killTmuxServer } from "../fixtures/live-claude.js";

type HookEvent = {
  hook_event_name: string;
  tool_input?: { prompt?: string };
  tool_response?: { content?: { text?: string }[] };
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

const conditionalGateFlow = (): Flow =>
  flow(
    [
      labelled(trigger("t"), "Start"),
      labelled(agent("a"), "A"),
      labelled(
        gate("h", { settings: { stopWhen: "conditional", condition: "tests fail" } }),
        "Guard",
      ),
      labelled(agent("b"), "B"),
      labelled(output("o"), "Stop"),
    ],
    [thenWire("t", "a"), thenWire("a", "h"), thenWire("h", "b"), thenWire("b", "o")],
  );

const producingFlow = (): Flow =>
  flow(
    [
      labelled(trigger("t"), "Start"),
      labelled(
        agent("c", {
          settings: { produces: [{ variable: "x", yesIf: "it holds", noIf: "it does not" }] },
        }),
        "Check",
      ),
      labelled(output("o"), "Stop"),
    ],
    [thenWire("t", "c"), thenWire("c", "o")],
  );

const branchFlow = (): Flow =>
  flow(
    [
      labelled(trigger("t"), "Start"),
      labelled(branch("b", "go"), "Go?"),
      labelled(agent("y"), "Ship"),
      labelled(agent("n"), "Hold"),
      labelled(output("o"), "Stop"),
    ],
    [
      thenWire("t", "b"),
      wire("b", "yes", "y", "in"),
      wire("b", "no", "n", "in"),
      thenWire("y", "o"),
      thenWire("n", "o"),
    ],
  );

const alwaysGateFlow = (): Flow =>
  flow(
    [
      labelled(trigger("t"), "Start"),
      labelled(gate("g", { settings: { stopWhen: "always", instruction: "Check it" } }), "Ask"),
      labelled(agent("a"), "A"),
      labelled(output("o"), "Stop"),
    ],
    [thenWire("t", "g"), thenWire("g", "a"), thenWire("a", "o")],
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

const answeringSocket = (events: HookEvent[]) =>
  createServer((socket) => {
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      text += chunk;
      const lines = text.split("\n");
      text = lines.pop() ?? "";
      for (const line of lines.filter((entry) => entry.trim() !== "")) {
        events.push(JSON.parse(line) as HookEvent);
        socket.write("{}\n");
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

  const runFake = async (
    input: Flow,
    agentFiles: Record<string, string> = {},
    { prompt = "/fork:run", claudeMd }: { prompt?: string; claudeMd?: string } = {},
  ) => {
    dir = await mkdtemp(join(tmpdir(), "fd-fake-session-"));
    const bin = join(dir, "bin");
    await writeFakeClaude(bin);
    if (claudeMd !== undefined) await writeFile(join(dir, "CLAUDE.md"), claudeMd);
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
      prompt,
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

  it("stops at a Conditional Gate after a node holding the met verb", async () => {
    const events = await runFake(conditionalGateFlow(), { a: "fake: met" });

    expect(
      events.filter((event) => event.hook_event_name !== "UserPromptSubmit").map(labelOf),
    ).toEqual(["PreToolUse a", "PostToolUse a", "Stop"]);
    expect(events.at(-1)?.last_assistant_message?.split("\n").at(-1)).toBe("STOPPED NODE h");
  });

  describe("a session Agent that produces a variable", () => {
    const replyOf = (events: HookEvent[]) =>
      events.find(
        (event) => event.hook_event_name === "PostToolUse" && labelOf(event) === "PostToolUse c",
      )?.tool_response?.content?.[0]?.text;

    it("returns the fenced json setting it when the Agent holds a set line", async () => {
      const events = await runFake(producingFlow(), { c: "Check it.\nfake: set x yes\n" });

      expect(parseProducedValues(replyOf(events), ["x"])).toEqual({
        values: { x: true },
        missing: [],
      });
    });

    it("returns a reply setting nothing when the Agent holds no set line", async () => {
      const events = await runFake(producingFlow(), { c: "Check it.\n" });

      expect(parseProducedValues(replyOf(events), ["x"])).toEqual({ values: {}, missing: ["x"] });
    });
  });

  describe("a session Branch", () => {
    const summary = "# Build fork\n\n- Variable go: false\n";
    const dispatched = (events: HookEvent[]) =>
      events.filter((event) => event.hook_event_name === "PreToolUse").map(labelOf);

    it("takes the path the run's choices pick over the build summary", async () => {
      const events = await runFake(
        branchFlow(),
        {},
        { prompt: "/fork:run Run choices: auto mode, go=yes", claudeMd: summary },
      );

      expect(dispatched(events)).toEqual(["PreToolUse y"]);
    });

    it("takes the build summary's path when the run has no choices", async () => {
      const events = await runFake(branchFlow(), {}, { claudeMd: summary });

      expect(dispatched(events)).toEqual(["PreToolUse n"]);
    });
  });

  describe("a session Always Gate", () => {
    const settled = () => new Promise((done) => setTimeout(done, 500));

    it("stops and pauses without auto mode in the run's choices", async () => {
      const events = await runFake(alwaysGateFlow());
      await settled();

      expect(
        events.filter((event) => event.hook_event_name !== "UserPromptSubmit").map(labelOf),
      ).toEqual(["Stop"]);
    });

    it("goes on in auto mode", async () => {
      const events = await runFake(
        alwaysGateFlow(),
        {},
        { prompt: "/fork:run Run choices: auto mode" },
      );

      expect(
        events.filter((event) => event.hook_event_name !== "UserPromptSubmit").map(labelOf),
      ).toEqual(["PreToolUse a", "PostToolUse a", "Stop"]);
    });
  });

  describe("a workspace turn whose Agent sets variables", () => {
    const row = (variable: string) => ({ variable, yesIf: "it holds", noIf: "it does not" });

    const replyTo = async (variables: string[], agentFile: string) => {
      dir = await mkdtemp(join(tmpdir(), "fd-fake-session-"));
      const bin = join(dir, "bin");
      await writeFakeClaude(bin);
      const agents = join(dir, "plugin", "agents");
      await mkdir(agents, { recursive: true });
      await writeFile(join(agents, "check.md"), agentFile);
      const sessions = new TmuxSessionHost({ socketName: name });
      const command = [
        process.execPath,
        join(bin, "fake-claude.cjs"),
        "--session-id",
        randomUUID(),
        "--plugin-dir",
        join(dir, "plugin"),
      ]
        .map(shellQuote)
        .join(" ");
      const sock = join(dir, "hooks.sock");
      const events: HookEvent[] = [];
      hooks = answeringSocket(events);
      await new Promise<void>((listening) => hooks?.listen(sock, listening));
      await sessions.start(name, dir, command, { FLOWDECK_SOCK: sock });
      const cli = new ClaudeCli({ sessions, readyTimeoutMs: 5000 });
      await cli.waitUntilReady(name);

      await cli.sendPrompt(
        name,
        agentTurnText("fork", "check", { id: "check", produces: variables.map(row) }),
      );

      await expect
        .poll(() => events.some((event) => event.hook_event_name === "Stop"), { timeout: 10_000 })
        .toBe(true);
      return events.find((event) => event.hook_event_name === "Stop")?.last_assistant_message;
    };

    it.each([
      ["yes", true],
      ["no", false],
    ])(
      "ends the turn with the fenced json the runner reads for set approved %s",
      async (word, value) => {
        const reply = await replyTo(["approved"], `Check it.\nfake: set approved ${word}\n`);

        expect(reply).toContain(`\`\`\`json\n{"approved": ${String(value)}}\n\`\`\``);
        expect(parseProducedValues(reply, ["approved"])).toEqual({
          values: { approved: value },
          missing: [],
        });
      },
    );

    it("combines several set lines into one object", async () => {
      const reply = await replyTo(
        ["approved", "docs"],
        "Check it.\nfake: set approved yes\nfake: set docs no\n",
      );

      expect(parseProducedValues(reply, ["approved", "docs"])).toEqual({
        values: { approved: true, docs: false },
        missing: [],
      });
    });

    it("sets nothing when the Agent holds no set line", async () => {
      const reply = await replyTo(["approved"], "Check it.\n");

      expect(parseProducedValues(reply, ["approved"])).toEqual({
        values: {},
        missing: ["approved"],
      });
    });
  });
});
