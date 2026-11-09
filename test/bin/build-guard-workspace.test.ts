import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitWorktree } from "../../src/adapters/git/worktree.js";
import { NodeFileSystem } from "../../src/adapters/node-fs/node-file-system.js";
import { layDown, workspaceDir } from "../../src/core/compiler/build.js";
import { buildSessionSettings } from "../../src/core/compiler/build-session.js";
import { buildHookCommand, shellQuote } from "../../src/core/compiler/hook-settings.js";
import { buildWorktree } from "../../src/core/run/workspace.js";
import { agent, onMainFlow, prompt, thenWire } from "../fixtures/flow-builders.js";
import { createTmpRepo, type TmpRepo } from "../fixtures/tmp-repo.js";

const run = promisify(execFile);
const guardPath = fileURLToPath(new URL("../../bin/flowdeck-build-guard.ts", import.meta.url));
const fixture: Record<string, unknown> = JSON.parse(
  await readFile(new URL("../fixtures/hooks/pre-tool-use.json", import.meta.url), "utf8"),
);

const committer = [
  "-c",
  "user.name=Flowdeck Test",
  "-c",
  "user.email=test@flowdeck.invalid",
  "-c",
  "commit.gpgsign=false",
];

const build = { id: "b-guard-0001-2222-3333", name: "guarded" };

let home: string;
let repo: TmpRepo;
let dir: string;
let worktreePath: string;
let preToolUse: string[];

async function snapshot(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      const key = relative(root, full);
      if (entry.isDirectory()) {
        entries[`${key}/`] = "dir";
        await walk(full);
      } else {
        entries[key] = createHash("sha256")
          .update(await readFile(full))
          .digest("hex");
      }
    }
  };
  await walk(root);
  return entries;
}

type Call = { tool_name: string; tool_input: Record<string, unknown> };

function denied(call: Call): boolean {
  const input = JSON.stringify({ ...fixture, cwd: dir, ...call });
  return preToolUse.some((command) => {
    const result = spawnSync("/bin/sh", ["-c", command], { cwd: dir, input, encoding: "utf8" });
    if (result.status === 2) return true;
    const out = result.stdout.trim();
    if (out === "") return false;
    const parsed = JSON.parse(out) as { hookSpecificOutput?: { permissionDecision?: unknown } };
    return parsed.hookSpecificOutput?.permissionDecision === "deny";
  });
}

async function perform({ tool_name, tool_input }: Call): Promise<void> {
  const path = resolve(dir, String(tool_input["file_path"]));
  if (tool_name === "Write") await writeFile(path, String(tool_input["content"]));
  if (tool_name === "Bash")
    await run("/bin/sh", ["-c", String(tool_input["command"])], { cwd: dir });
  if (tool_name === "Edit") {
    const text = await readFile(path, "utf8");
    await writeFile(
      path,
      text.replace(String(tool_input["old_string"]), String(tool_input["new_string"])),
    );
  }
}

async function attempt(call: Call): Promise<boolean> {
  const refused = denied(call);
  if (!refused) await perform(call);
  return refused;
}

beforeAll(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "fd-guard-home-")));
  repo = await createTmpRepo();
  await writeFile(join(repo.path, "README.md"), "hello\n");
  await run("git", ["-C", repo.path, "add", "README.md"]);
  await run("git", ["-C", repo.path, ...committer, "commit", "--quiet", "-m", "readme"]);
  await run("git", ["-C", repo.path, "branch", "-M", "main"]);

  const laidDown = await layDown(onMainFlow([prompt("p"), agent("a")], [thenWire("p", "a")]), {
    home,
    workspace: { ...build, repo: repo.path, base: "main", values: {} },
  });
  if (!laidDown.ok) throw new Error(JSON.stringify(laidDown.errors));
  dir = workspaceDir(home, build.id);
  const fs = new NodeFileSystem();
  for (const file of laidDown.files) await fs.writeFile(`${dir}/${file.path}`, file.content);

  const worktree = { ...buildWorktree({ ...build, repo: repo.path, dir }), repo: repo.path };
  await new GitWorktree().add({ ...worktree, base: "main" });
  worktreePath = worktree.path;

  const guardCommand = [process.execPath, guardPath, dir].map(shellQuote).join(" ");
  const settings = buildSessionSettings({ guardCommand, hookCommand: buildHookCommand });
  preToolUse = settings.hooks.PreToolUse.filter(
    (entry) => entry.matcher === undefined || entry.matcher === "" || entry.matcher === "*",
  ).flatMap((entry) => entry.hooks.map((hook) => hook.command));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await repo.cleanup();
});

describe("the build guard in a laid-down workspace", () => {
  it("has a workspace CLAUDE.md, no new agent file yet, and the worktree's README", async () => {
    expect((await stat(join(dir, "CLAUDE.md"))).isFile()).toBe(true);
    await expect(stat(join(dir, "plugin/agents/new.md"))).rejects.toThrow();
    expect(await readFile(join(worktreePath, "README.md"), "utf8")).toBe("hello\n");
    expect(worktreePath.startsWith(`${dir}/`)).toBe(true);
  });

  it.each<[string, () => Call]>([
    [
      "a Write of a new plugin/agents/new.md",
      () => ({
        tool_name: "Write",
        tool_input: { file_path: "plugin/agents/new.md", content: "---\nname: new\n---\n" },
      }),
    ],
    ["a Bash rm CLAUDE.md", () => ({ tool_name: "Bash", tool_input: { command: "rm CLAUDE.md" } })],
    [
      "an Edit inside the worktree",
      () => ({
        tool_name: "Edit",
        tool_input: {
          file_path: join(worktreePath, "README.md"),
          old_string: "hello",
          new_string: "changed",
        },
      }),
    ],
  ])("denies %s and leaves the workspace and worktree unchanged", async (_, call) => {
    const before = await snapshot(dir);

    const refused = await attempt(call());

    expect(refused).toBe(true);
    expect(await snapshot(dir)).toStrictEqual(before);
  });
});
