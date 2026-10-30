import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type TmpRepo = { path: string; cleanup: () => Promise<void> };

const committer = [
  "-c",
  "user.name=Flowdeck Test",
  "-c",
  "user.email=test@flowdeck.invalid",
  "-c",
  "commit.gpgsign=false",
];

export async function createTmpRepo(options: { commit?: boolean } = {}): Promise<TmpRepo> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "fd-repo-")));
  if (options.commit) {
    await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: path });
    await run("git", [...committer, "commit", "--quiet", "--allow-empty", "-m", "initial"], {
      cwd: path,
    });
  } else {
    await run("git", ["init", "--quiet"], { cwd: path });
  }
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}
