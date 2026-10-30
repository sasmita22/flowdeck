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
  openTerminal: (size) => ipcRenderer.invoke(bridgeChannels.openTerminal, size),
  getTerminalStatus: () => ipcRenderer.invoke(bridgeChannels.getTerminalStatus),
  writeTerminal: (data) => ipcRenderer.send(bridgeChannels.terminalInput, data),
  resizeTerminal: (size) => ipcRenderer.send(bridgeChannels.terminalResize, size),
  closeTerminal: () => ipcRenderer.send(bridgeChannels.closeTerminal),
  onTerminalStatus: (listener) => {
    const handler = (_event: unknown, status: unknown) => listener(status);
    ipcRenderer.on(bridgeChannels.terminalStatus, handler);
    return () => {
      ipcRenderer.removeListener(bridgeChannels.terminalStatus, handler);
    };
  },
  onTerminalData: (listener) => {
    const handler = (_event: unknown, data: unknown) => listener(data);
    ipcRenderer.on(bridgeChannels.terminalData, handler);
    return () => {
      ipcRenderer.removeListener(bridgeChannels.terminalData, handler);
    };
  },
  getActivity: () => ipcRenderer.invoke(bridgeChannels.getActivity),
  onActivity: (listener) => {
    const handler = (_event: unknown, update: unknown) => listener(update);
    ipcRenderer.on(bridgeChannels.activity, handler);
    return () => {
      ipcRenderer.removeListener(bridgeChannels.activity, handler);
    };
  },
};

contextBridge.exposeInMainWorld("flowdeck", bridge);
