import { app, BrowserWindow, ipcMain, utilityProcess } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EngineResponse, StoreOpenResult } from "../engine/protocol.js";
import { bridgeChannels, type StoreStatus } from "../preload/bridge.js";
import { EngineClient } from "./engine-client.js";
import { resolveFlowdeckHome } from "./flowdeck-home.js";

const toStoreStatus = (result: StoreOpenResult): StoreStatus =>
  result.kind === "ready" ? { kind: "ready" } : { kind: "error", message: result.message };

function startEngine(home: string) {
  const engine = utilityProcess.fork(join(__dirname, "engine.cjs"), [], {
    env: { ...process.env, FLOWDECK_HOME: home },
  });
  engine.once("spawn", () => console.log("main: engine started"));
  const client = new EngineClient({
    port: {
      postMessage: (message) => engine.postMessage(message),
      onMessage: (listener) =>
        engine.on("message", (response: EngineResponse) => listener(response)),
      onExit: (listener) => engine.on("exit", () => listener()),
    },
    timeoutMs: 5000,
  });
  return { engine, client };
}

function openWindow() {
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
    void window.loadFile(join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
}

void app.whenReady().then(() => {
  const { engine, client } = startEngine(resolveFlowdeckHome(process.env, homedir()));
  ipcMain.handle(bridgeChannels.version, () => client.request("version"));
  ipcMain.handle(bridgeChannels.storeStatus, async () =>
    toStoreStatus((await client.request("store-status")) as StoreOpenResult),
  );
  app.on("will-quit", () => engine.kill());
  openWindow();
});

app.on("window-all-closed", () => app.quit());
