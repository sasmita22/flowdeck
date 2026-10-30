import { contextBridge, ipcRenderer } from "electron";
import { bridgeChannels, type FlowdeckBridge, type StoreStatus } from "./bridge.js";

const bridge: FlowdeckBridge = {
  version: () => ipcRenderer.invoke(bridgeChannels.version) as Promise<string>,
  storeStatus: () => ipcRenderer.invoke(bridgeChannels.storeStatus) as Promise<StoreStatus>,
  saveFlow: (flow) => ipcRenderer.invoke(bridgeChannels.saveFlow, flow),
  loadLatestFlow: () => ipcRenderer.invoke(bridgeChannels.loadLatestFlow),
  setDirty: (dirty) => ipcRenderer.send(bridgeChannels.setDirty, dirty),
  onCloseRequest: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(bridgeChannels.closeRequest, handler);
    return () => {
      ipcRenderer.removeListener(bridgeChannels.closeRequest, handler);
    };
  },
  answerClose: (answer) => ipcRenderer.send(bridgeChannels.closeAnswer, answer),
  startRun: () => ipcRenderer.invoke(bridgeChannels.startRun),
  getRunState: () => ipcRenderer.invoke(bridgeChannels.getRunState),
  onRunState: (listener) => {
    const handler = (_event: unknown, snapshot: unknown) => listener(snapshot);
    ipcRenderer.on(bridgeChannels.runState, handler);
    return () => {
      ipcRenderer.removeListener(bridgeChannels.runState, handler);
    };
  },
};

contextBridge.exposeInMainWorld("flowdeck", bridge);
