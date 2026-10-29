import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp, playwrightPage, type LaunchedApp } from "../scripts/drive.js";

let home: string;
let logDir: string;
let opened: LaunchedApp[];

const open = async () => {
  const launched = await launchApp({ home, logPath: join(logDir, "app.log") });
  opened.push(launched);
  await expect(launched.window.getByTestId("canvas-save")).toBeVisible();
  return launched;
};

const readout = async (window: Page) =>
  JSON.parse((await window.getByTestId("canvas-flow").textContent()) ?? "") as {
    nodes: { type: string }[];
  };

const exited = (launched: LaunchedApp) =>
  new Promise<void>((resolve) => {
    const proc = launched.app.process();
    if (proc.exitCode !== null || proc.signalCode !== null) resolve();
    else proc.once("exit", () => resolve());
  });

const closeWindow = (launched: LaunchedApp) =>
  launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });

const edit = async ({ window }: LaunchedApp) => {
  await playwrightPage(window).drag("palette-prompt", "canvas", { x: 200, y: 150 });
  await expect(window.getByTestId("flow-unsaved")).toBeVisible();
  const edited = await readout(window);
  expect(edited.nodes.map((node) => node.type)).toEqual(["prompt"]);
  return edited;
};

const editThenClose = async (launched: LaunchedApp) => {
  const edited = await edit(launched);
  await closeWindow(launched);
  await expect(launched.window.getByTestId("close-save")).toBeVisible();
  return edited;
};

test.beforeEach(async () => {
  opened = [];
  home = await mkdtemp(join(tmpdir(), "fd-e2e-home-"));
  logDir = await mkdtemp(join(tmpdir(), "fd-e2e-log-"));
});

test.afterEach(async () => {
  try {
    const closed = await Promise.allSettled(opened.map((launched) => launched.close()));
    const failed = closed.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed) throw failed.reason;
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
  }
});

test("Save writes the edit, closes the app, and a relaunch reopens it clean", async () => {
  const first = await open();
  const edited = await editThenClose(first);

  await first.window.getByTestId("close-save").click();
  await exited(first);

  const second = await open();
  expect(await readout(second.window)).toEqual(edited);
  await expect(second.window.getByTestId("flow-unsaved")).toHaveCount(0);
});

test("Don't save closes the app without writing, and a relaunch opens an empty flow", async () => {
  const first = await open();
  await editThenClose(first);

  await first.window.getByTestId("close-discard").click();
  await exited(first);

  const second = await open();
  expect((await readout(second.window)).nodes).toEqual([]);
  await expect(second.window.getByTestId("flow-unsaved")).toHaveCount(0);
});

test("Cancel keeps the window open with the edit still unsaved", async () => {
  const first = await open();
  const edited = await editThenClose(first);

  await first.window.getByTestId("close-cancel").click();

  await expect(first.window.getByTestId("close-save")).toHaveCount(0);
  expect(first.window.isClosed()).toBe(false);
  expect(first.app.process().exitCode).toBeNull();
  await expect(first.window.getByTestId("flow-unsaved")).toBeVisible();
  expect(await readout(first.window)).toEqual(edited);
});

test("Quitting the app asks to save, Save writes the edit and quits, and a relaunch reopens it", async () => {
  const first = await open();
  const edited = await edit(first);

  await first.app.evaluate(({ app }) => app.quit());
  await expect(first.window.getByTestId("close-save")).toBeVisible();
  expect(first.app.process().exitCode).toBeNull();

  await first.window.getByTestId("close-save").click();
  await exited(first);

  const second = await open();
  expect(await readout(second.window)).toEqual(edited);
  await expect(second.window.getByTestId("flow-unsaved")).toHaveCount(0);
});

test("After the renderer reloads mid-prompt, closing the window closes the app", async () => {
  const first = await open();
  await editThenClose(first);

  await first.window.reload();
  await expect(first.window.getByTestId("canvas-save")).toBeVisible();
  await expect(first.window.getByTestId("flow-unsaved")).toHaveCount(0);

  await closeWindow(first);
  await exited(first);
});

test("After the renderer reloads mid-prompt, a new edit asks again on close", async () => {
  const first = await open();
  await editThenClose(first);

  await first.window.reload();
  await expect(first.window.getByTestId("canvas-save")).toBeVisible();
  await expect(first.window.getByTestId("flow-unsaved")).toHaveCount(0);

  await editThenClose(first);
  await first.window.getByTestId("close-discard").click();
  await exited(first);
});

test("After the renderer crashes mid-prompt, closing the window closes the app", async () => {
  const first = await open();
  await editThenClose(first);

  await first.app.evaluate(
    ({ BrowserWindow }) =>
      new Promise<void>((resolve) => {
        const contents = BrowserWindow.getAllWindows()[0]?.webContents;
        contents?.once("render-process-gone", () => resolve());
        contents?.forcefullyCrashRenderer();
      }),
  );
  await closeWindow(first);
  await exited(first);
});
