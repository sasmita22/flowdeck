import { contextBridge, ipcRenderer } from "electron";
import {
  bridgeChannels,
  engineCalls,
  type EngineCalls,
  type FlowdeckBridge,
  type StoreStatus,
} from "./bridge.js";

const calls = Object.fromEntries(
  Object.entries(engineCalls).map(([method, { channel }]) => [
    method,
    (payload?: unknown) => ipcRenderer.invoke(channel, payload),
  ]),
) as EngineCalls;

const bridge: FlowdeckBridge = {
  ...calls,
  version: () => ipcRenderer.invoke(bridgeChannels.version) as Promise<string>,
  storeStatus: () => ipcRenderer.invoke(bridgeChannels.storeStatus) as Promise<StoreStatus>,
  saveFlow: (flow) => ipcRenderer.invoke(bridgeChannels.saveFlow, flow),
  setDirty: (dirty) => ipcRenderer.send(bridgeChannels.setDirty, dirty),
  onCloseRequest: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(bridgeChannels.closeRequest, handler);
    return () => {
      ipcRenderer.removeListener(bridgeChannels.closeRequest, handler);
    };
  },
  answerClose: (answer) => ipcRenderer.send(bridgeChannels.closeAnswer, answer),
  getRunState: (runId) => ipcRenderer.invoke(bridgeChannels.getRunState, runId),
  onRunState: (listener) => {
    const handler = (_event: unknown, snapshot: unknown) => listener(snapshot);
    ipcRenderer.on(bridgeChannels.runState, handler);
    return () => {
      ipcRenderer.removeListener(bridgeChannels.runState, handler);
    };
  },
  openTerminal: (runId, size) => ipcRenderer.invoke(bridgeChannels.openTerminal, runId, size),
  getTerminalStatus: (runId) => ipcRenderer.invoke(bridgeChannels.getTerminalStatus, runId),
  writeTerminal: (runId, data) => ipcRenderer.send(bridgeChannels.terminalInput, runId, data),
  resizeTerminal: (runId, size) => ipcRenderer.send(bridgeChannels.terminalResize, runId, size),
  closeTerminal: (runId) => ipcRenderer.send(bridgeChannels.closeTerminal, runId),
  popOutTerminal: (runId) => ipcRenderer.invoke(bridgeChannels.popOutTerminal, runId),
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
  getActivity: (runId) => ipcRenderer.invoke(bridgeChannels.getActivity, runId),
  onActivity: (listener) => {
    const handler = (_event: unknown, update: unknown) => listener(update);
    ipcRenderer.on(bridgeChannels.activity, handler);
    return () => {
      ipcRenderer.removeListener(bridgeChannels.activity, handler);
    };
  },
  getWait: (runId) => ipcRenderer.invoke(bridgeChannels.getWait, runId),
  onWait: (listener) => {
    const handler = (_event: unknown, value: unknown) => listener(value);
    ipcRenderer.on(bridgeChannels.wait, handler);
    return () => {
      ipcRenderer.removeListener(bridgeChannels.wait, handler);
    };
  },
  answerWait: (answer) => ipcRenderer.invoke(bridgeChannels.answerWait, answer) as Promise<boolean>,
  workspaceInfo: (buildConfig) => ipcRenderer.invoke(bridgeChannels.workspaceInfo, buildConfig),
  onBuildProgress: (listener) => {
    const handler = (_event: unknown, update: unknown) => listener(update);
    ipcRenderer.on(bridgeChannels.buildProgress, handler);
    return () => {
      ipcRenderer.removeListener(bridgeChannels.buildProgress, handler);
    };
  },
  onBuildActivity: (listener) => {
    const handler = (_event: unknown, update: unknown) => listener(update);
    ipcRenderer.on(bridgeChannels.buildActivity, handler);
    return () => {
      ipcRenderer.removeListener(bridgeChannels.buildActivity, handler);
    };
  },
};

contextBridge.exposeInMainWorld("flowdeck", bridge);
