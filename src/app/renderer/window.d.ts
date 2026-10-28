import type { FlowdeckBridge } from "../preload/bridge.js";

declare global {
  interface Window {
    flowdeck: FlowdeckBridge;
  }
}
