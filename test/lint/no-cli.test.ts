import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const thisFile = "test/lint/no-cli.test.ts";

const cliTraces: { name: string; pattern: RegExp }[] = [
  { name: "src/cli", pattern: /src\/cli/ },
  { name: "runCli", pattern: /runCli/ },
  { name: "CliWaiter", pattern: /CliWaiter/ },
  { name: "cli-waiter", pattern: /cli-waiter/ },
  { name: "fixtures/cli-build", pattern: /fixtures\/cli-build/ },
  { name: "fixtures/live-build", pattern: /fixtures\/live-build/ },
  { name: "fakeCliBuild", pattern: /fakeCliBuild/ },
  { name: "`cli`", pattern: /`cli`/ },
  { name: "flowdeck command", pattern: /`?flowdeck`? command/ },
];

const repoFiles = (): string[] =>
  execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\n")
    .filter((file) => file !== "" && file !== thisFile)
    .filter((file) => existsSync(join(repoRoot, file)));

describe("no CLI left", () => {
  it("has no src/cli or test/cli folder", () => {
    expect(["src/cli", "test/cli"].filter((dir) => existsSync(join(repoRoot, dir)))).toEqual([]);
  });

  it("names the CLI in no file", () => {
    const offenders = repoFiles().flatMap((file) => {
      const source = readFileSync(join(repoRoot, file), "utf8");
      return cliTraces
        .filter(({ pattern }) => pattern.test(source))
        .map(({ name }) => `${file}: ${name}`);
    });

    expect(offenders).toEqual([]);
  });
});
