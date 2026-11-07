import { _electron, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import type * as Electron from "electron";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { SqliteFlowStore } from "../src/adapters/sqlite/flows.js";
import { controlTestIds, pageTestIds } from "../src/app/renderer/test-ids.js";
import { testDisplayFlags, withWindowMode } from "./window-mode.js";

const stepSchemas = {
  click: z.object({ type: z.literal("click"), testid: z.string().min(1) }),
  "right-click": z.object({ type: z.literal("right-click"), testid: z.string().min(1) }),
  type: z.object({ type: z.literal("type"), testid: z.string().min(1), text: z.string() }),
  "wait-for-text": z.object({
    type: z.literal("wait-for-text"),
    text: z.string().min(1),
    timeoutMs: z.number().int().positive().optional(),
  }),
  screenshot: z.object({ type: z.literal("screenshot") }),
  drag: z.object({
    type: z.literal("drag"),
    from: z.string().min(1),
    to: z.string().min(1),
    toPosition: z.object({ x: z.number(), y: z.number() }).optional(),
  }),
  press: z.object({ type: z.literal("press"), key: z.string().min(1) }),
  "close-window": z.strictObject({ type: z.literal("close-window") }),
  relaunch: z.strictObject({ type: z.literal("relaunch") }),
  "resize-window": z.strictObject({
    type: z.literal("resize-window"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  pause: z.strictObject({ type: z.literal("pause"), ms: z.number().int().positive().max(60_000) }),
};

type Point = { x: number; y: number };

export type Step = z.infer<(typeof stepSchemas)[keyof typeof stepSchemas]>;

export interface DrivePage {
  click(testid: string): Promise<void>;
  rightClick(testid: string): Promise<void>;
  waitFor(testid: string, timeoutMs: number): Promise<void>;
  type(testid: string, text: string): Promise<void>;
  waitForText(text: string, timeoutMs: number): Promise<void>;
  drag(from: string, to: string, toPosition?: Point): Promise<void>;
  press(key: string): Promise<void>;
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

export interface DriveSession {
  closeWindow(): Promise<boolean>;
  relaunch(): Promise<DrivePage>;
  resizeWindow(width: number, height: number): Promise<void>;
}

type PageStep = Exclude<Step, { type: "close-window" | "relaunch" | "resize-window" | "pause" }>;

async function runPageStep(step: PageStep, index: number, page: DrivePage, outDir: string) {
  switch (step.type) {
    case "click":
      return page.click(step.testid);
    case "right-click":
      return page.rightClick(step.testid);
    case "type":
      return page.type(step.testid, step.text);
    case "wait-for-text":
      return page.waitForText(step.text, step.timeoutMs ?? defaultWaitMs);
    case "drag":
      return page.drag(step.from, step.to, step.toPosition);
    case "press":
      return page.press(step.key);
    case "screenshot": {
      const name = `step-${index + 1}`;
      await page.screenshot(join(outDir, `${name}.png`));
      await writeFile(join(outDir, `${name}.aria.yml`), await page.ariaSnapshot());
      return;
    }
  }
}

const noSession = (type: string) =>
  new Error(`a ${type} step needs an app to drive, and none was given`);

export async function runSteps(
  steps: readonly Step[],
  page: DrivePage,
  options: { outDir: string; app?: DriveSession },
): Promise<void> {
  let current: DrivePage | undefined = page;
  for (const [index, step] of steps.entries()) {
    try {
      if (step.type === "close-window") {
        if (options.app === undefined) throw noSession(step.type);
        if (await options.app.closeWindow()) current = undefined;
      } else if (step.type === "relaunch") {
        if (options.app === undefined) throw noSession(step.type);
        current = await options.app.relaunch();
      } else if (step.type === "resize-window") {
        if (options.app === undefined) throw noSession(step.type);
        await options.app.resizeWindow(step.width, step.height);
      } else if (step.type === "pause") {
        await sleep(step.ms);
      } else {
        if (current === undefined) {
          throw new Error("the window was closed; add a relaunch step before this one");
        }
        await runPageStep(step, index, current, options.outDir);
      }
    } catch (error) {
      throw new Error(`${stepLabel(index, step.type)}: ${messageOf(error)}`, { cause: error });
    }
  }
}

async function boxOf(page: Page, testid: string) {
  const box = await page.getByTestId(testid).boundingBox();
  if (box === null) throw new Error(`${testid} is not visible`);
  return box;
}

export function playwrightPage(page: Page): DrivePage {
  return {
    click: (testid) => page.getByTestId(testid).click(),
    rightClick: (testid) => page.getByTestId(testid).click({ button: "right" }),
    waitFor: (testid, timeoutMs) => page.getByTestId(testid).waitFor({ timeout: timeoutMs }),
    type: (testid, text) => page.getByTestId(testid).fill(text),
    waitForText: (text, timeoutMs) => page.getByText(text).first().waitFor({ timeout: timeoutMs }),
    drag: async (from, to, toPosition) => {
      await page.getByTestId(from).scrollIntoViewIfNeeded();
      await page.getByTestId(to).scrollIntoViewIfNeeded();
      const start = await boxOf(page, from);
      const end = await boxOf(page, to);
      const target =
        toPosition === undefined
          ? { x: end.x + end.width / 2, y: end.y + end.height / 2 }
          : { x: Math.round(end.x + toPosition.x), y: Math.round(end.y + toPosition.y) };
      await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
      await page.mouse.down();
      await page.mouse.move(target.x, target.y, { steps: 10 });
      await page.mouse.up();
    },
    press: (key) => page.keyboard.press(key),
    screenshot: async (path) => {
      await page.screenshot({ path });
    },
    ariaSnapshot: async () =>
      `# title: ${await page.title()}\n${await page.locator("body").ariaSnapshot()}\n`,
  };
}

const openCanvasWaitMs = 30_000;

export async function openCanvas(
  page: DrivePage,
  { flowId }: { flowId?: string | undefined },
): Promise<void> {
  const opener = flowId === undefined ? pageTestIds.create : pageTestIds.blueprintOpen(flowId);
  if (flowId === undefined) await page.waitForText("No blueprints yet", openCanvasWaitMs);
  else await page.waitFor(opener, openCanvasWaitMs);
  await page.click(opener);
  await page.waitFor(controlTestIds.save, openCanvasWaitMs);
}

export function latestFlowId(home: string): string | undefined {
  let db: Database.Database;
  try {
    db = new Database(join(home, "flowdeck.db"), { readonly: true, fileMustExist: true });
  } catch {
    return undefined;
  }
  try {
    const flows = new SqliteFlowStore({ db });
    return flows.loadLatest()?.flowId ?? flows.list()[0]?.flowId;
  } finally {
    db.close();
  }
}

export interface DriveProcess {
  readonly pid?: number | undefined;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  once(event: "exit", listener: () => void): unknown;
}

export interface DriveApp {
  process(): DriveProcess;
  firstWindow(): Promise<Page>;
  evaluate<R>(fn: (electron: typeof Electron) => R | Promise<R>): Promise<R>;
  evaluate<R, Arg>(
    fn: (electron: typeof Electron, arg: Arg) => R | Promise<R>,
    arg: Arg,
  ): Promise<R>;
}

export type ColorScheme = "light" | "dark";

export type Launch = (
  home: string,
  colorScheme?: ColorScheme,
  env?: Readonly<Record<string, string>>,
) => Promise<DriveApp>;

export interface LaunchedApp {
  app: DriveApp;
  window: Page;
  close(): Promise<void>;
}

const hasExited = (proc: DriveProcess) => proc.exitCode !== null || proc.signalCode !== null;

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

const pollMs = 25;
const defaultExitGraceMs = 10_000;

async function waitUntil(done: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
  return true;
}

const defaultEngineStopMs = 10_000;

export async function forceExit(app: DriveApp, options: { timeoutMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? defaultEngineStopMs;
  const proc = app.process();
  if (hasExited(proc)) return;
  let exited = false;
  proc.once("exit", () => {
    exited = true;
  });
  const appExited = () => exited || hasExited(proc);
  const evaluateUnlessGone = async <R>(evaluate: () => Promise<R>): Promise<R | undefined> => {
    try {
      return await evaluate();
    } catch (error) {
      if (await waitUntil(appExited, Math.min(timeoutMs, 1000))) return undefined;
      throw error;
    }
  };
  const pids = await evaluateUnlessGone(() =>
    app.evaluate(({ app: electronApp }) => {
      const engines = electronApp
        .getAppMetrics()
        .filter(
          (metric) => metric.type === "Utility" && metric.serviceName === "node.mojom.NodeService",
        )
        .map((metric) => metric.pid);
      for (const pid of engines) {
        try {
          process.kill(pid, "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") console.error(error);
        }
      }
      return engines;
    }),
  );
  if (pids === undefined) return;
  const survivors = () => pids.filter(isRunning);
  await waitUntil(() => survivors().length === 0, timeoutMs);
  if (!appExited()) {
    const asked = await evaluateUnlessGone(() =>
      app.evaluate(({ app: electronApp }) => {
        setImmediate(() => electronApp.exit(0));
        return true;
      }),
    );
    if (asked !== undefined && !(await waitUntil(appExited, timeoutMs))) {
      throw new Error(`the app did not exit within ${timeoutMs} ms`);
    }
  }
  const outlived = survivors();
  if (outlived.length > 0) {
    throw new Error(`engine process ${outlived.join(", ")} outlived the app`);
  }
}

export const userDataFlag = (home: string) => `--user-data-dir=${join(home, "user-data")}`;

const launchElectron: Launch = (home, colorScheme, env = {}) =>
  _electron.launch({
    args: [...testDisplayFlags, userDataFlag(home), "."],
    cwd: repoRoot,
    env: { ...withWindowMode(process.env), ...env, FLOWDECK_HOME: home },
    ...(colorScheme && { colorScheme }),
  });

export type LaunchOptions = {
  home: string;
  logPath: string;
  launch?: Launch;
  colorScheme?: ColorScheme;
  env?: Readonly<Record<string, string>>;
};

export async function launchApp(options: LaunchOptions): Promise<LaunchedApp> {
  const launched = await (options.launch ?? launchElectron)(
    options.home,
    options.colorScheme,
    options.env,
  );
  const proc = launched.process();
  const app: DriveApp = {
    process: () => proc,
    firstWindow: () => launched.firstWindow(),
    evaluate: <R, Arg>(fn: (electron: typeof Electron, arg: Arg) => R | Promise<R>, arg?: Arg) =>
      launched.evaluate(fn, arg as Arg),
  };
  const log = createWriteStream(options.logPath, { flags: "a" });
  proc.stdout?.pipe(log, { end: false });
  proc.stderr?.pipe(log, { end: false });
  const close = async () => {
    try {
      await forceExit(app);
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

export async function launchOnCanvas(options: LaunchOptions): Promise<LaunchedApp> {
  const flowId = latestFlowId(options.home);
  const launched = await launchApp(options);
  try {
    await openCanvas(playwrightPage(launched.window), { flowId });
  } catch (error) {
    await launched.close().catch(() => undefined);
    throw error;
  }
  return launched;
}

export async function resolveHome(
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ home: string; keep: boolean }> {
  const own = env.FLOWDECK_HOME;
  if (own !== undefined && own !== "") return { home: own, keep: true };
  return { home: await mkdtemp(join(tmpdir(), "fd-drive-home-")), keep: false };
}

export async function drive(
  steps: readonly Step[],
  options: {
    outDir: string;
    home: string;
    launch?: Launch;
    keepHome?: boolean;
    exitGraceMs?: number;
    onCanvas?: boolean;
  },
): Promise<void> {
  let launched: LaunchedApp | undefined;
  let closeRequested = false;
  const shutDown = async (app: LaunchedApp | undefined) => {
    if (app === undefined) return;
    if (closeRequested) {
      const proc = app.app.process();
      await waitUntil(() => hasExited(proc), options.exitGraceMs ?? defaultExitGraceMs);
    }
    await app.close();
  };
  const launch = async () => {
    closeRequested = false;
    launched = await (options.onCanvas === true ? launchOnCanvas : launchApp)({
      home: options.home,
      logPath: join(options.outDir, "app.log"),
      ...(options.launch && { launch: options.launch }),
    });
    process.stdout.write(`app pid: ${launched.app.process().pid}\n`);
    return launched;
  };
  const session: DriveSession = {
    closeWindow: async () => {
      closeRequested = true;
      return (
        (await launched?.app.evaluate(
          ({ BrowserWindow }) =>
            new Promise<boolean>((resolve) => {
              const window = BrowserWindow.getAllWindows()[0];
              if (window === undefined || window.isDestroyed()) {
                resolve(true);
                return;
              }
              window.once("close", (event) => resolve(!event.defaultPrevented));
              window.close();
            }),
        )) ?? true
      );
    },
    relaunch: async () => {
      const previous = launched;
      launched = undefined;
      await shutDown(previous);
      return playwrightPage((await launch()).window);
    },
    resizeWindow: async (width, height) => {
      await launched?.app.evaluate(
        ({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
        },
        { width, height },
      );
    },
  };
  const cleanUp = async () => {
    try {
      await shutDown(launched);
    } finally {
      if (options.keepHome !== true) await rm(options.home, { recursive: true, force: true });
    }
  };
  try {
    const first = await launch();
    await runSteps(steps, playwrightPage(first.window), { outDir: options.outDir, app: session });
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
  const { home, keep } = await resolveHome(process.env);
  process.stdout.write(`evidence: ${outDir}\nhome: ${home}\n`);
  await drive(steps, { outDir, home, keepHome: keep, onCanvas: true });
}

export function reportFailure(
  error: unknown,
  io: { write(text: string): unknown; exit(code: number): unknown } = {
    write: (text) => process.stderr.write(text),
    exit: (code) => process.exit(code),
  },
): void {
  io.write(`drive failed: ${messageOf(error)}\n`);
  io.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => reportFailure(error));
}
