import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchApp, type LaunchedApp } from "../scripts/drive.js";

const fakeClaude = `
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { connect } = require("node:net");
const { resolve } = require("node:path");
const argv = process.argv.slice(2);
appendFileSync(resolve(__dirname, "ran"), JSON.stringify(argv) + "\\n");
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(argv) + "\\n");
const flag = (name) => { const at = argv.indexOf(name); return at === -1 ? undefined : argv[at + 1]; };
const sessionId = flag("--session-id") ?? flag("--resume") ?? "";
const sock = process.env.FLOWDECK_SOCK ?? "";
const session = sock.slice(sock.lastIndexOf("/") + 1).replace(/\\.sock$/, "");
const buildSession = argv.filter((arg) => arg === "--plugin-dir").length === 2;
let typed = "";
const draw = () =>
  process.stdout.write(
    "\\x1b[2J\\x1b[HFake Claude in " + session + "\\r\\n────────\\r\\n❯ " + typed + "\\r\\n────────\\r\\n",
  );
const send = (event) => {
  const socket = connect(sock, () => {
    socket.end(JSON.stringify({ session_id: sessionId, ...event }) + "\\n");
  });
  socket.on("error", () => undefined);
};
const stop = () => send({ hook_event_name: "Stop", last_assistant_message: "ok" });

const unfilledLine = /^@unfilled.*\\n\\n?/m;
const descriptionLine = /^description: (.*)$/m;
const described = (content) =>
  content.replace(descriptionLine, (_line, raw) =>
    "description: " + JSON.stringify(JSON.parse(raw) + " Filled by the fake build session, long enough for the check."),
  );
const fill = (path) => {
  const file = resolve(process.cwd(), path);
  if (!existsSync(file)) return;
  const content = described(readFileSync(file, "utf8"));
  writeFileSync(file, content.replace(unfilledLine, "").trimEnd() + "\\n\\nFilled by the fake build session.\\n");
};
const pieceMsFile = resolve(__dirname, "piece-ms");
const pieceMs = existsSync(pieceMsFile) ? Number(readFileSync(pieceMsFile, "utf8")) : 0;
const spacing = 300 + 2 * pieceMs;
const questionFile = resolve(__dirname, "question");
const askAfterAudit = (agentType) => {
  if (agentType !== "flowdeck-build:handoff-auditor" || !existsSync(questionFile)) return;
  const question = JSON.parse(readFileSync(questionFile, "utf8"));
  const report = { version: 1, questions: [question], merges: [], keptApart: [], mixedJobs: [], pieces: [] };
  writeFileSync(resolve(process.cwd(), "build-report.json"), JSON.stringify(report, null, 2));
};
const usageFile = resolve(__dirname, "usage");
const writeUsage = () => {
  if (!existsSync(usageFile)) return;
  const { projectsDir, model, inputTokens, outputTokens } = JSON.parse(readFileSync(usageFile, "utf8"));
  mkdirSync(projectsDir, { recursive: true });
  const line = {
    type: "assistant",
    message: { id: "fake-usage", model, content: [], usage: { input_tokens: inputTokens, output_tokens: outputTokens } },
  };
  writeFileSync(resolve(projectsDir, sessionId + ".jsonl"), JSON.stringify(line) + "\\n");
};
const buildTurn = (text) => {
  writeUsage();
  const agentType = /flowdeck-build:[a-z-]+/.exec(text)?.[0] ?? "";
  const blocks = text.split(/\\n\\s*\\n/).map((block) => block.trim()).filter((block) => block.startsWith("PIECE "));
  blocks.forEach((block, index) => {
    setTimeout(() => {
      const path = block.split("\\n", 1)[0].slice("PIECE ".length).trim();
      const call = { tool_name: "Agent", tool_use_id: "fake-" + index, tool_input: { subagent_type: agentType, prompt: block } };
      send({ hook_event_name: "PreToolUse", ...call });
      const finish = () => {
        fill(path);
        send({ hook_event_name: "PostToolUse", ...call, tool_response: { agentType, status: "completed" } });
      };
      if (pieceMs === 0) finish();
      else setTimeout(finish, pieceMs);
    }, spacing * (index + 1));
  });
  setTimeout(() => {
    askAfterAudit(agentType);
    stop();
  }, spacing * (blocks.length + 1));
};
const drawBuild = () =>
  process.stdout.write(
    "\\x1b[2J\\x1b[Hfake build session\\r\\n────────\\r\\n❯ " + typed.replace(/\\s+/g, " ").slice(-120) + "\\r\\n────────\\r\\n",
  );

process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
if (buildSession) {
  process.stdout.on("resize", drawBuild);
  process.stdin.on("data", (chunk) => {
    for (const key of chunk) {
      if (key === "\\r") {
        if (typed.trim() !== "") buildTurn(typed);
        typed = "";
      } else if (key === "\\x7f") typed = typed.slice(0, -1);
      else if (key !== "\\x1b") typed += key;
    }
    drawBuild();
  });
  drawBuild();
} else {
  process.stdout.on("resize", draw);
  process.stdin.on("data", (chunk) => {
    for (const key of chunk) {
      if (key === "\\r" || key === "\\n") {
        if (typed !== "") setTimeout(stop, 50);
        typed = "";
      } else if (key === "\\x7f") typed = typed.slice(0, -1);
      else if (key !== "\\x1b") typed += key;
    }
    draw();
  });
  draw();
}
`;

export const fakeClaudeRan = (home: string) => join(home, "fake-claude-bin", "ran");

export type FakeClaudeLaunchOptions = Parameters<typeof launchApp>[0] & {
  ownBin?: string;
  basePath?: string;
  pieceMs?: number;
  question?: { nodeId: string; otherNodeId?: string; text: string };
  usage?: { userHome: string; model: string; inputTokens: number; outputTokens: number };
};

export async function launchWithFakeClaude(options: FakeClaudeLaunchOptions): Promise<LaunchedApp> {
  const { ownBin, basePath, pieceMs, question, usage, ...launchOptions } = options;
  const bin = join(options.home, "fake-claude-bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "fake-claude.cjs"), fakeClaude);
  if (pieceMs !== undefined) await writeFile(join(bin, "piece-ms"), String(pieceMs));
  if (question !== undefined) await writeFile(join(bin, "question"), JSON.stringify(question));
  if (usage !== undefined) {
    const { userHome, ...counts } = usage;
    const projectsDir = join(userHome, ".claude", "projects", "fd-fake");
    await mkdir(projectsDir, { recursive: true });
    await writeFile(join(bin, "usage"), JSON.stringify({ projectsDir, ...counts }));
  }
  const fake = `exec "${process.execPath}" "${join(bin, "fake-claude.cjs")}" "$@"`;
  const ownClaude =
    ownBin === undefined
      ? fake
      : [
          'pluginDirs=0; for arg in "$@"; do [ "$arg" = --plugin-dir ] && pluginDirs=$((pluginDirs + 1)); done',
          `[ "$pluginDirs" = 2 ] && ${fake}`,
          `exec "${join(ownBin, "claude")}" "$@"`,
        ].join("\n");
  await writeFile(join(bin, "claude"), `#!/bin/sh\n${ownClaude}\n`);
  await chmod(join(bin, "claude"), 0o755);
  const path = [bin, ownBin, basePath ?? process.env["PATH"] ?? ""]
    .filter((dir) => dir !== undefined && dir !== "")
    .join(":");
  const home = usage === undefined ? {} : { HOME: usage.userHome };
  return launchApp({ ...launchOptions, env: { ...options.env, ...home, PATH: path } });
}
