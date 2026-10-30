import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCli } from "../../src/adapters/claude/claude-cli.js";
import { TmuxSessionHost } from "../../src/adapters/tmux/tmux-session-host.js";
import { shellQuote } from "../../src/core/compiler/hook-settings.js";
import {
  killTmuxServer,
  readLines,
  removeClaudeSessions,
  sleep,
  tokenResults,
  type TranscriptEntry,
} from "../fixtures/live-claude.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const tmuxSocket = "fd-probe";

const holderScript = `import { appendFileSync } from "node:fs";
const [log, holdMs] = process.argv.slice(2);
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  appendFileSync(log, JSON.stringify({ at: Date.now(), payload: JSON.parse(input) }) + "\\n");
  setTimeout(() => {
    const decision = { behavior: "allow" };
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } }) + "\\n");
    appendFileSync(log, JSON.stringify({ at: Date.now(), released: "allow" }) + "\\n");
  }, Number(holdMs));
});
`;

type HolderLine = { at: number; payload?: { tool_name?: string }; released?: string };

describe.skipIf(process.env.FLOWDECK_LIVE !== "1")("plugin-dir PermissionRequest hook", () => {
  const sessions = new TmuxSessionHost({ socketName: tmuxSocket });
  const cli = new ClaudeCli({ sessions });
  let started: string[] = [];
  let probes: { dir: string; repo: TmpRepo; sessionId: string }[] = [];

  async function startProbe(label: string, timeoutSeconds: number, holdMs: number) {
    const token = `fd-perm-${randomUUID().slice(0, 8)}`;
    const dir = await mkdtemp(join(tmpdir(), "fd-probe-"));
    const repo = await createTmpRepo();
    const sessionId = randomUUID();
    probes.push({ dir, repo, sessionId });
    const pluginDir = join(dir, "plugin");
    await mkdir(join(pluginDir, "hooks"), { recursive: true });
    const holder = join(dir, "holder.mjs");
    const log = join(dir, "holder.log");
    await writeFile(holder, holderScript);
    const command = [process.execPath, holder, log, String(holdMs)].map(shellQuote).join(" ");
    await writeFile(
      join(pluginDir, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          PermissionRequest: [{ hooks: [{ type: "command", command, timeout: timeoutSeconds }] }],
        },
      }),
    );
    const settingsPath = join(pluginDir, "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({ permissions: { allow: ["Read", "Edit"], defaultMode: "default" } }),
    );
    const name = `fd-probe-${label}`;
    started.push(name);
    await cli.start(
      name,
      repo.path,
      { sessionId, model: "haiku" },
      { settingsPath, pluginDir, env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" } },
    );
    await cli.waitUntilReady(name);
    await cli.sendPrompt(
      name,
      `Run the Bash command \`node -e "console.log('${token}')"\` and reply with its output.`,
    );
    const sentAt = Date.now();

    const holderLines = () => readLines<HolderLine>(log);
    const results = async () => {
      const transcript = await cli.findTranscript(sessionId);
      if (!transcript) return [];
      return tokenResults(await readLines<TranscriptEntry>(transcript), token);
    };
    const pane = () => sessions.capture(name);
    return { sentAt, holderLines, results, pane };
  }

  async function firstRequest(holderLines: () => Promise<HolderLine[]>, ms: number) {
    const deadline = Date.now() + ms;
    for (;;) {
      const request = (await holderLines()).find((line) => line.payload !== undefined);
      if (request) return request;
      if (Date.now() >= deadline) throw new Error(`no PermissionRequest within ${ms} ms`);
      await sleep(250);
    }
  }

  afterEach(async () => {
    for (const name of started) {
      if (await sessions.has(name)) await sessions.stop(name);
    }
    started = [];
    await killTmuxServer(tmuxSocket);
    for (const { dir, repo, sessionId } of probes) {
      await removeClaudeSessions(repo.path, [sessionId]);
      await repo.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
    probes = [];
  }, 60_000);

  it(
    "P1 runs Bash once a hook with a long timeout allows after holding 90 s",
    { timeout: 300_000 },
    async () => {
      const probe = await startProbe("p1", 600, 90_000);

      const deadline = probe.sentAt + 180_000;
      let results = await probe.results();
      while (results.length === 0 && Date.now() < deadline) {
        await sleep(1000);
        results = await probe.results();
      }
      const pane = await probe.pane();
      const lines = await probe.holderLines();
      const requests = lines.filter((line) => line.payload !== undefined);
      console.log(
        `P1 pane:\n${pane}`,
        JSON.stringify(
          lines.map(({ at, released, payload }) => ({ at, released, tool: payload?.tool_name })),
        ),
        `resultAfterMs=${Date.now() - probe.sentAt}`,
      );

      expect(requests.map((line) => line.payload?.tool_name)).toEqual(["Bash"]);
      expect(results.length).toBeGreaterThan(0);
    },
  );

  it(
    "P2 never runs Bash when a hook with a 5 s timeout holds 30 s and then allows",
    { timeout: 300_000 },
    async () => {
      const probe = await startProbe("p2", 5, 30_000);

      const request = await firstRequest(probe.holderLines, 120_000);
      await sleep(Math.max(0, request.at + 25_000 - Date.now()));
      const at25s = await probe.results();
      await sleep(Math.max(0, request.at + 45_000 - Date.now()));
      const at45s = await probe.results();
      const pane = await probe.pane();
      const lines = await probe.holderLines();
      console.log(
        `P2 pane:\n${pane}`,
        JSON.stringify(
          lines.map(({ at, released, payload }) => ({ at, released, tool: payload?.tool_name })),
        ),
      );

      expect(at25s).toEqual([]);
      expect(at45s).toEqual([]);
    },
  );
});
