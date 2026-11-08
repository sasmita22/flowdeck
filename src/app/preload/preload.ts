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
  openTerminal: (session, size) => ipcRenderer.invoke(bridgeChannels.openTerminal, session, size),
  getTerminalStatus: (session) => ipcRenderer.invoke(bridgeChannels.getTerminalStatus, session),
  writeTerminal: (session, data) => ipcRenderer.send(bridgeChannels.terminalInput, session, data),
  resizeTerminal: (session, size) => ipcRenderer.send(bridgeChannels.terminalResize, session, size),
  closeTerminal: (session) => ipcRenderer.send(bridgeChannels.closeTerminal, session),
  popOutTerminal: (session) => ipcRenderer.invoke(bridgeChannels.popOutTerminal, session),
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
  onToolCall: (listener) => {
    const handler = (_event: unknown, call: unknown) => listener(call);
    ipcRenderer.on(bridgeChannels.toolCall, handler);
    return () => {
      ipcRenderer.removeListener(bridgeChannels.toolCall, handler);
    };
  },
  onToolTurnEnd: (listener) => {
    const handler = (_event: unknown, turnEnd: unknown) => listener(turnEnd);
    ipcRenderer.on(bridgeChannels.toolTurnEnd, handler);
    return () => {
      ipcRenderer.removeListener(bridgeChannels.toolTurnEnd, handler);
    };
  },
  answerToolCall: (requestId, result) =>
    ipcRenderer.send(bridgeChannels.answerToolCall, requestId, result),
};

contextBridge.exposeInMainWorld("flowdeck", bridge);
