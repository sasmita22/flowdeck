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
};

contextBridge.exposeInMainWorld("flowdeck", bridge);
