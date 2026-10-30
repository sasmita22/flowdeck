import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import type { StoreApi } from "zustand/vanilla";
import type { TerminalState } from "./store.js";

export function TerminalPane({ store }: { store: StoreApi<TerminalState> }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = container.current;
    if (element === null) return;
    const terminal = store.getState();
    const term = new Terminal();
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    fit.fit();
    const stopData = terminal.onData((data) => term.write(data));
    const input = term.onData((data) => terminal.input(data));
    const resize = term.onResize(({ cols, rows }) => terminal.resize({ cols, rows }));
    void terminal.attach({ cols: term.cols, rows: term.rows });
    term.focus();
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(element);
    return () => {
      observer.disconnect();
      stopData();
      input.dispose();
      resize.dispose();
      term.dispose();
    };
  }, [store]);

  return (
    <div>
      <button data-testid="terminal-close" onClick={() => store.getState().close()}>
        Close terminal
      </button>
      <div data-testid="terminal-view" ref={container} style={{ width: "100%", height: 320 }} />
    </div>
  );
}
