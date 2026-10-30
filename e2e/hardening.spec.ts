import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp, playwrightPage, type LaunchedApp } from "../scripts/drive.js";

const remoteUrl = "https://example.com/";
const settleMs = 2000;

type MainProbe = { fdSeen?: string[] };

let home: string;
let logDir: string;
let launched: LaunchedApp | undefined;
let app: LaunchedApp;
let window: Page;

const windowCount = (target: LaunchedApp) =>
  target.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

const seenInMain = (target: LaunchedApp) =>
  target.app.evaluate(() => (globalThis as MainProbe).fdSeen ?? []);

const armWindowCreated = (target: LaunchedApp) =>
  target.app.evaluate(({ app: electronApp }) => {
    const probe = globalThis as MainProbe;
    probe.fdSeen = [];
    electronApp.once("browser-window-created", () => probe.fdSeen?.push("browser-window-created"));
  });

const armWillNavigate = (target: LaunchedApp) =>
  target.app.evaluate(({ BrowserWindow }) => {
    const probe = globalThis as MainProbe;
    probe.fdSeen = [];
    BrowserWindow.getAllWindows()[0]?.webContents.once("will-navigate", (_event, url) =>
      probe.fdSeen?.push(url),
    );
  });

const urlInMain = (target: LaunchedApp) =>
  target.app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getURL() ?? "no window",
  );

const inMainWindow = <T, Arg>(
  target: LaunchedApp,
  read: (electron: typeof import("electron"), arg: Arg) => Promise<T>,
  arg: Arg,
) => target.app.evaluate(read, arg).catch(() => "app exited" as const);

const testIdVisible = (target: LaunchedApp, testId: string) =>
  inMainWindow(
    target,
    async ({ BrowserWindow }, selector) =>
      BrowserWindow.getAllWindows()[0]?.webContents.executeJavaScript(
        `document.querySelector(${selector})?.checkVisibility() === true`,
      ) as Promise<boolean | undefined>,
    JSON.stringify(`[data-testid="${testId}"]`),
  );

const navigateToRemote = async (target: LaunchedApp) => {
  await armWillNavigate(target);
  await target.window.evaluate((url) => {
    location.href = url;
  }, remoteUrl);
  await expect.poll(() => seenInMain(target)).toEqual([remoteUrl]);
  await target.window.waitForTimeout(settleMs);
};

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-e2e-home-"));
  logDir = await mkdtemp(join(tmpdir(), "fd-e2e-log-"));
  launched = await launchApp({ home, logPath: join(logDir, "app.log") });
  app = launched;
  window = launched.window;
  await expect(window.getByTestId("canvas-save")).toBeVisible();
});

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
  }
});

test("window.open opens no window", async () => {
  const returnedNull = await window.evaluate((url) => globalThis.open(url) === null, remoteUrl);
  await window.waitForTimeout(settleMs);

  expect({ returnedNull, windows: await windowCount(app) }).toEqual({
    returnedNull: true,
    windows: 1,
  });
});

test("a target=_blank link opens no window", async () => {
  await window.evaluate((url) => {
    const link = document.createElement("a");
    link.id = "fd-hardening-link";
    link.target = "_blank";
    link.href = url;
    link.textContent = "remote";
    document.body.append(link);
  }, remoteUrl);
  await armWindowCreated(app);

  await window.locator("#fd-hardening-link").click();
  await window.waitForTimeout(settleMs);

  expect({ seen: await seenInMain(app), windows: await windowCount(app) }).toEqual({
    seen: [],
    windows: 1,
  });
});

test("setting location to a remote URL keeps the app page", async () => {
  const appUrl = window.url();

  await navigateToRemote(app);

  expect(await urlInMain(app)).toBe(appUrl);
  await expect.poll(() => testIdVisible(app, "canvas-save")).toBe(true);
});

test("an injected inline script is blocked and the canvas still renders", async () => {
  const outcome = await window.evaluate(
    () =>
      new Promise<{ ran: boolean; directive: string | null }>((resolve) => {
        const probe = globalThis as { fdInjected?: boolean };
        const finish = (directive: string | null) =>
          resolve({ ran: probe.fdInjected === true, directive });
        document.addEventListener(
          "securitypolicyviolation",
          (event) => finish(event.violatedDirective),
          { once: true },
        );
        setTimeout(() => finish(null), 2000);
        const script = document.createElement("script");
        script.textContent = "globalThis.fdInjected = true;";
        document.head.append(script);
      }),
  );

  expect({
    ran: outcome.ran,
    blockedByScriptSrc: outcome.directive?.startsWith("script-src") ?? false,
  }).toEqual({ ran: false, blockedByScriptSrc: true });
  await expect(window.getByTestId("canvas-save")).toBeVisible();
});

test("an injected remote script is blocked and the canvas still renders", async () => {
  const blockedUri = await window.evaluate(
    (url) =>
      new Promise<string | null>((resolve) => {
        document.addEventListener("securitypolicyviolation", (event) => resolve(event.blockedURI), {
          once: true,
        });
        setTimeout(() => resolve(null), 2000);
        const script = document.createElement("script");
        script.src = new URL("fd-hardening.js", url).href;
        document.head.append(script);
      }),
    remoteUrl,
  );

  expect(blockedUri === null ? null : new URL(blockedUri).origin).toBe("https://example.com");
  await expect(window.getByTestId("canvas-save")).toBeVisible();
});

test("a dirty canvas still asks to save on close after a blocked navigation", async () => {
  await playwrightPage(window).drag("palette-prompt", "canvas", { x: 200, y: 150 });
  await expect(window.getByTestId("flow-unsaved")).toBeVisible();

  await navigateToRemote(app);
  await app.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });

  await expect.poll(() => testIdVisible(app, "close-save")).toBe(true);
});
