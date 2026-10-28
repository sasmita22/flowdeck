import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

type DriveResult = { code: number; stdout: string; stderr: string };

const runDrive = (stepsPath: string, outDir: string) =>
  new Promise<DriveResult>((resolve) => {
    execFile(
      "npx",
      ["tsx", "scripts/drive.ts", stepsPath, "--out", outDir],
      { cwd: repoRoot },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout, stderr });
      },
    );
  });

const printed = (stdout: string, label: string) => {
  const line = stdout.split("\n").find((entry) => entry.startsWith(`${label}: `));
  if (line === undefined) throw new Error(`drive printed no "${label}:" line:\n${stdout}`);
  return line.slice(label.length + 2);
};

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

let work: string;

test.beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "fd-e2e-drive-"));
});

test.afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

const drive = async (steps: unknown[]) => {
  const stepsPath = join(work, "steps.json");
  const outDir = join(work, "out");
  await writeFile(stepsPath, JSON.stringify(steps));
  return { outDir, result: await runDrive(stepsPath, outDir) };
};

test("leaves one screenshot, one ARIA snapshot and the app log, and removes its home", async () => {
  const { outDir, result } = await drive([
    { type: "wait-for-text", text: "Flowdeck" },
    { type: "screenshot" },
  ]);

  expect(result.code, result.stderr).toBe(0);
  expect((await readdir(outDir)).sort()).toEqual(["app.log", "step-2.aria.yml", "step-2.png"]);
  expect(await readFile(join(outDir, "step-2.aria.yml"), "utf8")).toContain("Flowdeck");
  const log = await readFile(join(outDir, "app.log"), "utf8");
  expect(log).toContain("main: engine started");
  expect(log).toContain("engine: store ready");
  expect(existsSync(printed(result.stdout, "home"))).toBe(false);
});

test("fails on a missing control, names the step, closes the app and removes its home", async () => {
  const { result } = await drive([
    { type: "wait-for-text", text: "Flowdeck" },
    { type: "click", testid: "no-such-control" },
  ]);

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("step 2 (click)");
  expect(isRunning(Number(printed(result.stdout, "app pid")))).toBe(false);
  expect(existsSync(printed(result.stdout, "home"))).toBe(false);
});
