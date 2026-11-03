import { createStore, type StoreApi } from "zustand/vanilla";
import { terminalStatusSchema, type TerminalSize } from "../../../core/run/terminal.js";
import type { FlowdeckBridge } from "../../preload/bridge.js";
import { pushFor } from "../run-push.js";

export type TerminalBridge = Pick<
  FlowdeckBridge,
  | "openTerminal"
  | "getTerminalStatus"
  | "writeTerminal"
  | "resizeTerminal"
  | "closeTerminal"
  | "popOutTerminal"
  | "onTerminalStatus"
  | "onTerminalData"
>;

export type TerminalState = {
  runId: string | null;
  available: boolean;
  attached: boolean;
  visible: boolean;
  poppedOut: boolean;
  connect(): Promise<void>;
  view(runId: string): Promise<void>;
  popOut(): Promise<void>;
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
      const { available, attached } = parsed.data;
      const poppedOut = parsed.data.poppedOut === true;
      const detached = get().attached && !attached;
      set(
        detached
          ? { available, attached, poppedOut, visible: false }
          : { available, attached, poppedOut },
      );
      return true;
    };

    return {
      runId: null,
      available: false,
      attached: false,
      visible: false,
      poppedOut: false,

      connect: async () => {
        bridge.onTerminalStatus((value) => {
          const push = pushFor(value, get().runId);
          if (push !== null && apply(push["status"])) pushed = true;
        });
      },

      view: async (runId) => {
        const { runId: previous, attached, poppedOut } = get();
        if (previous !== null && previous !== runId && attached && !poppedOut) {
          bridge.closeTerminal(previous);
        }
        pushed = false;
        set({ runId, available: false, attached: false, visible: false, poppedOut: false });
        const current = await bridge.getTerminalStatus(runId);
        if (!pushed && get().runId === runId) apply(current);
      },

      show: () => {
        const { available, visible } = get();
        if (available && !visible) set({ visible: true });
      },

      attach: async (size) => {
        const { runId } = get();
        if (runId === null) return;
        if ((await bridge.openTerminal(runId, size)) !== true) set({ visible: false });
      },

      input: (data) => {
        const { runId } = get();
        if (runId !== null) bridge.writeTerminal(runId, data);
      },

      resize: (size) => {
        const { runId } = get();
        if (runId !== null) bridge.resizeTerminal(runId, size);
      },

      popOut: async () => {
        const { runId } = get();
        if (runId !== null) await bridge.popOutTerminal(runId);
      },

      close: () => {
        const { runId } = get();
        if (runId !== null) bridge.closeTerminal(runId);
        set({ visible: false });
      },

      onData: (listener) =>
        bridge.onTerminalData((value) => {
          const data = pushFor(value, get().runId)?.["data"];
          if (typeof data === "string") listener(data);
        }),
    };
  });
