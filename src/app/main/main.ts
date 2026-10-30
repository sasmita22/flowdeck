import { app, BrowserWindow, ipcMain, utilityProcess } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node-pty";
import type { LoadLatestFlowResult } from "../../core/flow/flow-store.js";
import type { EngineMessage, StoreOpenResult } from "../engine/protocol.js";
import { bridgeChannels, type CloseAnswer, type StoreStatus } from "../preload/bridge.js";
import { createActivityRelay } from "./activity.js";
import { createCloseGuard } from "./close-guard.js";
import { EngineClient } from "./engine-client.js";
import { resolveFlowdeckHome } from "./flowdeck-home.js";
import { createTerminal, type Terminal } from "./pty.js";
import { createRunRelay, stopEngine } from "./run.js";
import { createWindowGuard, type WindowGuard } from "./window-guard.js";

const rendererIndexPath = join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);

const toStoreStatus = (result: StoreOpenResult): StoreStatus =>
  result.kind === "ready" ? { kind: "ready" } : { kind: "error", message: result.message };

const toLoadedFlow = (result: LoadLatestFlowResult): unknown => {
  if (result.kind === "error") throw new Error(result.message);
  return result.kind === "loaded" ? result.flow : null;
};

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

function openWindow(windowGuard: WindowGuard) {
  const window = new BrowserWindow({
    title: "Flowdeck",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL !== undefined) {
    void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void window.loadFile(rendererIndexPath);
  }
  window.webContents.setWindowOpenHandler(() => windowGuard.denyWindowOpen());
  window.webContents.on("will-navigate", (event) => {
    if (!windowGuard.allowsNavigation(event.url)) event.preventDefault();
  });
  return window;
}

function wireTerminal(window: BrowserWindow, windowGuard: WindowGuard): Terminal {
  const terminal = createTerminal({
    spawn,
    env: process.env,
    sendStatus: (status) => {
      if (!window.isDestroyed()) window.webContents.send(bridgeChannels.terminalStatus, status);
    },
    sendData: (data) => {
      if (!window.isDestroyed()) window.webContents.send(bridgeChannels.terminalData, data);
    },
  });
  ipcMain.handle(
    bridgeChannels.openTerminal,
    windowGuard.handle((size: unknown) => terminal.open(size)),
  );
  ipcMain.handle(
    bridgeChannels.getTerminalStatus,
    windowGuard.handle(() => terminal.status()),
  );
  ipcMain.on(
    bridgeChannels.terminalInput,
    windowGuard.listen((data: unknown) => terminal.write(data)),
  );
  ipcMain.on(
    bridgeChannels.terminalResize,
    windowGuard.listen((size: unknown) => terminal.resize(size)),
  );
  ipcMain.on(
    bridgeChannels.closeTerminal,
    windowGuard.listen(() => terminal.close()),
  );
  window.webContents.on("did-navigate", () => terminal.close());
  window.webContents.on("render-process-gone", () => terminal.close());
  return terminal;
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

void app.whenReady().then(() => {
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
  ipcMain.handle(
    bridgeChannels.loadLatestFlow,
    windowGuard.handle(async () =>
      toLoadedFlow((await client.request("load-latest-flow")) as LoadLatestFlowResult),
    ),
  );
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
  const terminal = wireTerminal(window, windowGuard);
  client.onPush((push) => {
    if (push.push === "session") terminal.setSession(push.value);
  });
  ipcMain.handle(
    bridgeChannels.startRun,
    windowGuard.handle(() => client.request("start-run")),
  );
  ipcMain.handle(
    bridgeChannels.getRunState,
    windowGuard.handle(() => relay.latest()),
  );
  ipcMain.handle(
    bridgeChannels.getActivity,
    windowGuard.handle(() => activity.feed()),
  );
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
