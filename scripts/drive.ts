import { _electron, type Page } from "@playwright/test";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const stepSchemas = {
  click: z.object({ type: z.literal("click"), testid: z.string().min(1) }),
  type: z.object({ type: z.literal("type"), testid: z.string().min(1), text: z.string() }),
  "wait-for-text": z.object({
    type: z.literal("wait-for-text"),
    text: z.string().min(1),
    timeoutMs: z.number().int().positive().optional(),
  }),
  screenshot: z.object({ type: z.literal("screenshot") }),
};

export type Step = z.infer<(typeof stepSchemas)[keyof typeof stepSchemas]>;

export interface DrivePage {
  click(testid: string): Promise<void>;
  type(testid: string, text: string): Promise<void>;
  waitForText(text: string, timeoutMs: number): Promise<void>;
  screenshot(path: string): Promise<void>;
  ariaSnapshot(): Promise<string>;
}

const defaultWaitMs = 10_000;
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const stepLabel = (index: number, type: unknown) => `step ${index + 1} (${String(type)})`;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const isStepType = (type: unknown): type is keyof typeof stepSchemas =>
  typeof type === "string" && Object.hasOwn(stepSchemas, type);

export function parseSteps(text: string): Step[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("steps.json is not valid JSON");
  }
  if (!Array.isArray(json)) throw new Error("steps.json must be a JSON array of steps");
  return json.map((raw: unknown, index) => {
    const type = typeof raw === "object" && raw !== null ? (raw as { type?: unknown }).type : raw;
    if (!isStepType(type)) throw new Error(`${stepLabel(index, type)}: unknown step type`);
    const parsed = stepSchemas[type].safeParse(raw);
    if (!parsed.success) {
      throw new Error(`${stepLabel(index, type)}: ${z.prettifyError(parsed.error)}`);
    }
    return parsed.data;
  });
}

async function runStep(step: Step, index: number, page: DrivePage, outDir: string) {
  switch (step.type) {
    case "click":
      return page.click(step.testid);
    case "type":
      return page.type(step.testid, step.text);
    case "wait-for-text":
      return page.waitForText(step.text, step.timeoutMs ?? defaultWaitMs);
    case "screenshot": {
      const name = `step-${index + 1}`;
      await page.screenshot(join(outDir, `${name}.png`));
      await writeFile(join(outDir, `${name}.aria.yml`), await page.ariaSnapshot());
      return;
    }
  }
}

export async function runSteps(
  steps: readonly Step[],
  page: DrivePage,
  options: { outDir: string },
): Promise<void> {
  for (const [index, step] of steps.entries()) {
    try {
      await runStep(step, index, page, options.outDir);
    } catch (error) {
      throw new Error(`${stepLabel(index, step.type)}: ${messageOf(error)}`, { cause: error });
    }
  }
}

export function playwrightPage(page: Page): DrivePage {
  return {
    click: (testid) => page.getByTestId(testid).click(),
    type: (testid, text) => page.getByTestId(testid).fill(text),
    waitForText: (text, timeoutMs) => page.getByText(text).first().waitFor({ timeout: timeoutMs }),
    screenshot: async (path) => {
      await page.screenshot({ path });
    },
    ariaSnapshot: async () =>
      `# title: ${await page.title()}\n${await page.locator("body").ariaSnapshot()}\n`,
  };
}

export interface DriveApp {
  process(): {
    readonly pid?: number | undefined;
    readonly stdout: Readable | null;
    readonly stderr: Readable | null;
  };
  firstWindow(): Promise<Page>;
  close(): Promise<void>;
}

export type Launch = (home: string) => Promise<DriveApp>;

export interface LaunchedApp {
  app: DriveApp;
  window: Page;
  close(): Promise<void>;
}

const launchElectron: Launch = (home) =>
  _electron.launch({ args: ["."], cwd: repoRoot, env: { ...process.env, FLOWDECK_HOME: home } });

export async function launchApp(options: {
  home: string;
  logPath: string;
  launch?: Launch;
}): Promise<LaunchedApp> {
  const app = await (options.launch ?? launchElectron)(options.home);
  const log = createWriteStream(options.logPath);
  app.process().stdout?.pipe(log, { end: false });
  app.process().stderr?.pipe(log, { end: false });
  const close = async () => {
    try {
      await app.close();
    } finally {
      log.end();
      await finished(log);
    }
  };
  try {
    return { app, window: await app.firstWindow(), close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

export async function drive(
  steps: readonly Step[],
  options: { outDir: string; home: string; launch?: Launch },
): Promise<void> {
  let launched: LaunchedApp | undefined;
  const cleanUp = async () => {
    try {
      await launched?.close();
    } finally {
      await rm(options.home, { recursive: true, force: true });
    }
  };
  try {
    launched = await launchApp({
      home: options.home,
      logPath: join(options.outDir, "app.log"),
      ...(options.launch && { launch: options.launch }),
    });
    process.stdout.write(`app pid: ${launched.app.process().pid}\n`);
    await runSteps(steps, playwrightPage(launched.window), { outDir: options.outDir });
  } catch (error) {
    await cleanUp().catch(() => undefined);
    throw error;
  }
  await cleanUp();
}

function parseArgs(argv: readonly string[]): { stepsPath: string; outDir: string | undefined } {
  const [stepsPath, ...rest] = argv;
  if (stepsPath === undefined) throw new Error("usage: drive <steps.json> [--out <dir>]");
  const outFlag = rest.indexOf("--out");
  return { stepsPath, outDir: outFlag === -1 ? undefined : rest[outFlag + 1] };
}

async function main(): Promise<void> {
  const { stepsPath, outDir: outArg } = parseArgs(process.argv.slice(2));
  const steps = parseSteps(await readFile(stepsPath, "utf8"));
  const outDir = outArg ?? (await mkdtemp(join(tmpdir(), "fd-drive-")));
  await mkdir(outDir, { recursive: true });
  const home = await mkdtemp(join(tmpdir(), "fd-drive-home-"));
  process.stdout.write(`evidence: ${outDir}\nhome: ${home}\n`);
  await drive(steps, { outDir, home });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`drive failed: ${messageOf(error)}\n`);
    process.exitCode = 1;
  });
}
