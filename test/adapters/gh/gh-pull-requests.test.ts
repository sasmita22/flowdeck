import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhPullRequests } from "../../../src/adapters/gh/gh-pull-requests.js";

const branch = "flowdeck/fix-login-1a2b3c4d";

let folder: string;
let repo: string;

async function stubGh(output: string): Promise<string> {
  const path = join(folder, "gh");
  await writeFile(
    path,
    [
      "#!/bin/sh",
      `[ "$*" = "pr list --head ${branch} --state open --json number" ] || exit 2`,
      `[ "$(pwd -P)" = "${repo}" ] || exit 3`,
      output,
      "",
    ].join("\n"),
  );
  await chmod(path, 0o755);
  return path;
}

describe("GhPullRequests", () => {
  beforeEach(async () => {
    folder = await realpath(await mkdtemp(join(tmpdir(), "fd-gh-")));
    repo = join(folder, "repo");
    await mkdir(repo);
    vi.spyOn(console, "log");
    vi.spyOn(console, "warn");
    vi.spyOn(console, "error");
  });

  afterEach(async () => {
    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    await rm(folder, { recursive: true, force: true });
  });

  it("finds no pull request when gh lists none open on the branch", async () => {
    const command = await stubGh("printf '[]\\n'");

    await expect(new GhPullRequests({ command }).openOn(repo, branch)).resolves.toBe("none");
  });

  it("finds an open pull request when gh lists one on the branch", async () => {
    const command = await stubGh("printf '[{\"number\":7}]\\n'");

    await expect(new GhPullRequests({ command }).openOn(repo, branch)).resolves.toBe("open");
  });

  it("cannot tell when gh exits non-zero, as when logged out or the remote is not on GitHub", async () => {
    const command = await stubGh("printf '[]'\necho 'not logged in' >&2\nexit 1");

    await expect(new GhPullRequests({ command }).openOn(repo, branch)).resolves.toBe("unknown");
  });

  it("cannot tell when gh is not installed", async () => {
    const command = join(folder, "missing-gh");

    await expect(new GhPullRequests({ command }).openOn(repo, branch)).resolves.toBe("unknown");
  });

  it("cannot tell when gh prints JSON that is not a list", async () => {
    const command = await stubGh("printf '{\"number\":7}\\n'");

    await expect(new GhPullRequests({ command }).openOn(repo, branch)).resolves.toBe("unknown");
  });

  it("cannot tell when gh prints something that is not JSON", async () => {
    const command = await stubGh("printf 'Welcome to GitHub CLI\\n'");

    await expect(new GhPullRequests({ command }).openOn(repo, branch)).resolves.toBe("unknown");
  });
});
