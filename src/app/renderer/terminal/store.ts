import { createStore, type StoreApi } from "zustand/vanilla";
import { terminalStatusSchema, type TerminalSize } from "../../../core/run/terminal.js";
import type { FlowdeckBridge } from "../../preload/bridge.js";

export type TerminalBridge = Pick<
  FlowdeckBridge,
  | "openTerminal"
  | "getTerminalStatus"
  | "writeTerminal"
  | "resizeTerminal"
  | "closeTerminal"
  | "onTerminalStatus"
  | "onTerminalData"
>;

export type TerminalState = {
  available: boolean;
  attached: boolean;
  visible: boolean;
  connect(): Promise<void>;
  show(): void;
  attach(size: TerminalSize): Promise<void>;
  input(data: string): void;
  resize(size: TerminalSize): void;
  close(): void;
  onData(listener: (data: string) => void): () => void;
};

export const selectOpenDisabled = (terminal: Pick<TerminalState, "available">): boolean =>
  !terminal.available;

export const createTerminalStore = ({
  bridge,
}: {
  bridge: TerminalBridge;
}): StoreApi<TerminalState> =>
  createStore<TerminalState>()((set, get) => {
    let pushed = false;

    const apply = (value: unknown): boolean => {
      const parsed = terminalStatusSchema.safeParse(value);
      if (!parsed.success) return false;
      const detached = get().attached && !parsed.data.attached;
      set(detached ? { ...parsed.data, visible: false } : parsed.data);
      return true;
    };

    return {
      available: false,
      attached: false,
      visible: false,

      connect: async () => {
        bridge.onTerminalStatus((value) => {
          if (apply(value)) pushed = true;
        });
        const current = await bridge.getTerminalStatus();
        if (!pushed) apply(current);
      },

      show: () => {
        const { available, visible } = get();
        if (available && !visible) set({ visible: true });
      },

      attach: async (size) => {
        if ((await bridge.openTerminal(size)) !== true) set({ visible: false });
      },

      input: (data) => bridge.writeTerminal(data),

      resize: (size) => bridge.resizeTerminal(size),

      close: () => {
        bridge.closeTerminal();
        set({ visible: false });
      },

      onData: (listener) =>
        bridge.onTerminalData((data) => {
          if (typeof data === "string") listener(data);
        }),
    };
  });
