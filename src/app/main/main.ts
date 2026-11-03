import { app, BrowserWindow, ipcMain, nativeTheme, screen, utilityProcess } from "electron";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node-pty";
import type { EngineMessage, StoreOpenResult } from "../engine/protocol.js";
import {
  bridgeChannels,
  engineCalls,
  type CloseAnswer,
  type StoreStatus,
} from "../preload/bridge.js";
import { createActivityRelay } from "./activity.js";
import { createCloseGuard } from "./close-guard.js";
import { EngineClient } from "./engine-client.js";
import { resolveFlowdeckHome } from "./flowdeck-home.js";
import { loginPath } from "./login-path.js";
import { createTerminal } from "./pty.js";
import { createRunRelay, stopEngine } from "./run.js";
import { answerWait, createWaitRelay } from "./wait.js";
import { createWindowGuard, type WindowGuard } from "./window-guard.js";
import { workspaceInfoHandler } from "./workspace.js";
import { defaultWindowBounds, minimumWindowSize } from "./window-size.js";

const rendererIndexPath = join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);

const toStoreStatus = (result: StoreOpenResult): StoreStatus =>
  result.kind === "ready" ? { kind: "ready" } : { kind: "error", message: result.message };

const loginShellTimeoutMs = 3000;

const runLoginShell = (command: string, args: readonly string[]) =>
  new Promise<{ code: number | null; stdout: string }>((resolve) => {
    execFile(
      command,
      args,
      { cwd: homedir(), timeout: loginShellTimeoutMs, killSignal: "SIGKILL" },
      (error, stdout) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        resolve({ code, stdout });
      },
    );
  });

async function useLoginPath() {
  const path = await loginPath({
    shell: process.env["SHELL"],
    run: runLoginShell,
    timeoutMs: loginShellTimeoutMs,
  });
  if (path !== undefined) process.env["PATH"] = path;
}

function startEngine(home: string) {
  const engine = utilityProcess.fork(join(__dirname, "engine.cjs"), [], {
    env: { ...process.env, FLOWDECK_HOME: home },
  });
  engine.once("spawn", () => console.log("main: engine started"));
  const exited = new Promise<void>((resolve) => engine.once("exit", () => resolve()));
  const client = new EngineClient({
    port: {
      postMessage: (message) => engine.postMessage(message),
      onMessage: (listener) => engine.on("message", (message: EngineMessage) => listener(message)),
      onExit: (listener) => engine.on("exit", () => listener()),
    },
    timeoutMs: 5000,
  });
  return { engine, client, exited };
}

const hiddenWindows = () => process.env["FLOWDECK_HIDE_WINDOW"] === "1";

function appWindow(
  windowGuard: WindowGuard,
  options: Pick<
    Electron.BrowserWindowConstructorOptions,
    "title" | "x" | "y" | "width" | "height" | "minWidth" | "minHeight"
  >,
  hash?: string,
) {
  const hidden = hiddenWindows();
  const window = new BrowserWindow({
    ...options,
    show: !hidden,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: !hidden,
    },
  });
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL !== undefined) {
    void window.loadURL(
      hash === undefined
        ? MAIN_WINDOW_VITE_DEV_SERVER_URL
        : `${MAIN_WINDOW_VITE_DEV_SERVER_URL}#${hash}`,
    );
  } else {
    void window.loadFile(rendererIndexPath, hash === undefined ? {} : { hash });
  }
  window.webContents.setWindowOpenHandler(() => windowGuard.denyWindowOpen());
  window.webContents.on("will-navigate", (event) => {
    if (!windowGuard.allowsNavigation(event.url)) event.preventDefault();
  });
  return window;
}

function openWindow(windowGuard: WindowGuard) {
  nativeTheme.themeSource = "dark";
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const minimumSize = minimumWindowSize(workArea);
  return appWindow(windowGuard, {
    title: "Flowdeck",
    ...defaultWindowBounds(workArea),
    minWidth: minimumSize.width,
    minHeight: minimumSize.height,
  });
}

const toEveryWindow = (channel: string, value: unknown) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, value);
  }
};

function wireTerminal(window: BrowserWindow, windowGuard: WindowGuard) {
  const terminal = createTerminal({
    spawn,
    env: process.env,
    sendStatus: (runId, status) => toEveryWindow(bridgeChannels.terminalStatus, { runId, status }),
    sendData: (runId, data) => toEveryWindow(bridgeChannels.terminalData, { runId, data }),
  });
  const runIds = new Set<string>();
  const popOuts = new Map<string, BrowserWindow>();
  const closeAll = () => {
    for (const runId of runIds) terminal.close(runId);
  };
  ipcMain.handle(
    bridgeChannels.popOutTerminal,
    windowGuard.handle((runId: string) => {
      if (!terminal.status(runId).available) return false;
      const existing = popOuts.get(runId);
      if (existing !== undefined && !existing.isDestroyed()) {
        existing.focus();
        return true;
      }
      terminal.close(runId);
      const opened = appWindow(
        windowGuard,
        { title: "Flowdeck terminal", width: 900, height: 560, minWidth: 360, minHeight: 200 },
        `terminal/${encodeURIComponent(runId)}`,
      );
      popOuts.set(runId, opened);
      terminal.setPoppedOut(runId, true);
      opened.on("closed", () => {
        popOuts.delete(runId);
        terminal.close(runId);
        terminal.setPoppedOut(runId, false);
      });
      return true;
    }),
  );
  window.on("closed", () => {
    for (const popOut of popOuts.values()) if (!popOut.isDestroyed()) popOut.close();
  });
  ipcMain.handle(
    bridgeChannels.openTerminal,
    windowGuard.handle((runId: string, size: unknown) => terminal.open(runId, size)),
  );
  ipcMain.handle(
    bridgeChannels.getTerminalStatus,
    windowGuard.handle((runId: string) => terminal.status(runId)),
  );
  ipcMain.on(
    bridgeChannels.terminalInput,
    windowGuard.listen((runId: string, data: unknown) => terminal.write(runId, data)),
  );
  ipcMain.on(
    bridgeChannels.terminalResize,
    windowGuard.listen((runId: string, size: unknown) => terminal.resize(runId, size)),
  );
  ipcMain.on(
    bridgeChannels.closeTerminal,
    windowGuard.listen((runId: string) => terminal.close(runId)),
  );
  window.webContents.on("did-navigate", closeAll);
  window.webContents.on("render-process-gone", closeAll);
  const setSession = (runId: string, name: string | null) => {
    runIds.add(runId);
    terminal.setSession(runId, name);
  };
  return { setSession, dispose: () => terminal.dispose() };
}

function guardClose(window: BrowserWindow, windowGuard: WindowGuard) {
  const guard = createCloseGuard({
    requestClose: () => window.webContents.send(bridgeChannels.closeRequest),
    closeWindow: () => window.close(),
  });
  ipcMain.on(
    bridgeChannels.setDirty,
    windowGuard.listen((dirty: boolean) => guard.setDirty(dirty)),
  );
  ipcMain.on(
    bridgeChannels.closeAnswer,
    windowGuard.listen((answer: CloseAnswer) => guard.answer(answer)),
  );
  window.on("close", (event) => guard.onClose(event));
  window.webContents.on("did-navigate", () => guard.reset());
  window.webContents.on("render-process-gone", () => guard.reset());
}

void app.whenReady().then(async () => {
  if (app.isPackaged) await useLoginPath();
  const { engine, client, exited } = startEngine(resolveFlowdeckHome(process.env, homedir()));
  const windowGuard = createWindowGuard({
    appUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL ?? pathToFileURL(rendererIndexPath).href,
  });
  ipcMain.handle(
    bridgeChannels.version,
    windowGuard.handle(() => client.request("version")),
  );
  ipcMain.handle(
    bridgeChannels.storeStatus,
    windowGuard.handle(async () =>
      toStoreStatus((await client.request("store-status")) as StoreOpenResult),
    ),
  );
  ipcMain.handle(
    bridgeChannels.saveFlow,
    windowGuard.handle((flow: unknown) => client.request("save-flow", flow)),
  );
  for (const { channel, request } of Object.values(engineCalls)) {
    ipcMain.handle(
      channel,
      windowGuard.handle((payload: unknown) => client.request(request, payload)),
    );
  }
  const window = openWindow(windowGuard);
  const relay = createRunRelay({
    send: (snapshot) => {
      if (!window.isDestroyed()) window.webContents.send(bridgeChannels.runState, snapshot);
    },
  });
  client.onPush(relay.onPush);
  const activity = createActivityRelay({
    send: (update) => {
      if (!window.isDestroyed()) window.webContents.send(bridgeChannels.activity, update);
    },
  });
  client.onPush(activity.onPush);
  const wait = createWaitRelay({
    send: (value) => {
      if (!window.isDestroyed()) window.webContents.send(bridgeChannels.wait, value);
    },
  });
  client.onPush(wait.onPush);
  const terminal = wireTerminal(window, windowGuard);
  client.onPush((push) => {
    if (push.push === "session") terminal.setSession(push.runId, push.value);
  });
  ipcMain.handle(
    bridgeChannels.getRunState,
    windowGuard.handle((runId: string) => relay.latest(runId)),
  );
  ipcMain.handle(
    bridgeChannels.getActivity,
    windowGuard.handle((runId: string) => activity.feed(runId)),
  );
  ipcMain.handle(
    bridgeChannels.getWait,
    windowGuard.handle((runId: string) => wait.latest(runId)),
  );
  ipcMain.handle(
    bridgeChannels.answerWait,
    windowGuard.handle((payload: unknown) => answerWait(client, payload)),
  );
  ipcMain.handle(bridgeChannels.workspaceInfo, workspaceInfoHandler(windowGuard, client));
  let quitting = false;
  app.on("will-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    terminal.dispose();
    void stopEngine({ kill: () => engine.kill(), exited, timeoutMs: 10_000 }).then((result) => {
      console.log(`main: engine stopped (${result})`);
      app.exit(0);
    });
  });
  guardClose(window, windowGuard);
});

app.on("window-all-closed", () => app.quit());
