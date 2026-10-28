import { contextBridge, ipcRenderer } from "electron";
import { bridgeChannels, type FlowdeckBridge, type StoreStatus } from "./bridge.js";

const bridge: FlowdeckBridge = {
  version: () => ipcRenderer.invoke(bridgeChannels.version) as Promise<string>,
  storeStatus: () => ipcRenderer.invoke(bridgeChannels.storeStatus) as Promise<StoreStatus>,
};

contextBridge.exposeInMainWorld("flowdeck", bridge);
